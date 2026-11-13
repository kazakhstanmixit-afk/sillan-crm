-- Sillan CRM — 20. Маршруты без возвратов: день растёт цепочкой соседних точек (без «одиноких»
-- точек на другом конце города), порядок объезда — от края района, ближайшая следующая + 2-opt.

-- Порядок объезда точек (открытый маршрут). Старт — ближе всего к p_start (если задан),
-- иначе самая дальняя от центра точка (край района). Затем ближайшая следующая и 2-opt.
create or replace function app.route_order(p_ids uuid[], p_lat double precision[], p_lng double precision[],
  p_start_lat double precision default null, p_start_lng double precision default null)
returns uuid[] language plpgsql immutable as $$
declare
  n int := coalesce(array_length(p_ids, 1), 0);
  ord int[] := '{}';
  used boolean[];
  cur int; best int; bd double precision; dd double precision;
  clat double precision; clng double precision;
  improved boolean := true; guard int := 0;
  i int; k int; a int; b int; c int; e int; delta double precision;
  res uuid[] := '{}';
begin
  if n <= 2 then return p_ids; end if;
  used := array_fill(false, array[n]);
  -- старт
  if p_start_lat is not null then
    select g into cur from generate_series(1, n) g order by app.km(p_lat[g], p_lng[g], p_start_lat, p_start_lng) limit 1;
  else
    select avg(x), avg(y) into clat, clng from unnest(p_lat, p_lng) as t(x, y);
    select g into cur from generate_series(1, n) g order by app.km(p_lat[g], p_lng[g], clat, clng) desc limit 1;
  end if;
  -- ближайшая следующая
  for i in 1..n loop
    ord := ord || cur; used[cur] := true;
    best := null; bd := null;
    for k in 1..n loop
      if not used[k] then
        dd := app.km(p_lat[cur], p_lng[cur], p_lat[k], p_lng[k]);
        if bd is null or dd < bd then bd := dd; best := k; end if;
      end if;
    end loop;
    exit when best is null;
    cur := best;
  end loop;
  -- 2-opt для открытого маршрута (старт фиксирован): разворачиваем отрезок, если путь короче
  while improved and guard < 50 loop
    improved := false; guard := guard + 1;
    for i in 2..n - 1 loop
      for k in i + 1..n loop
        a := ord[i - 1]; b := ord[i]; c := ord[k];
        if k < n then
          e := ord[k + 1];
          delta := app.km(p_lat[a], p_lng[a], p_lat[c], p_lng[c]) + app.km(p_lat[b], p_lng[b], p_lat[e], p_lng[e])
                 - app.km(p_lat[a], p_lng[a], p_lat[b], p_lng[b]) - app.km(p_lat[c], p_lng[c], p_lat[e], p_lng[e]);
        else
          delta := app.km(p_lat[a], p_lng[a], p_lat[c], p_lng[c]) - app.km(p_lat[a], p_lng[a], p_lat[b], p_lng[b]);
        end if;
        if delta < -0.001 then
          ord := ord[1:i - 1] || (select array_agg(ord[j] order by j desc) from generate_series(i, k) j) || ord[k + 1:n];
          improved := true;
        end if;
      end loop;
    end loop;
  end loop;
  for i in 1..n loop res := res || p_ids[ord[i]]; end loop;
  return res;
end $$;
revoke execute on function app.route_order(uuid[], double precision[], double precision[], double precision, double precision) from public, anon;

-- Переупорядочить план дня: выполненные — как были, остальные — от последней выполненной (или от края района)
create or replace function app.reorder_plan_nn(p_plan uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  k int;
  s_lat double precision; s_lng double precision;
  ids uuid[];
begin
  k := coalesce((select max(position) from public.visits where plan_id = p_plan and status <> 'planned'), 0);
  select l.lat, l.lng into s_lat, s_lng from public.visits v join public.locations l on l.id = v.location_id
   where v.plan_id = p_plan and v.status = 'done' and l.lat is not null order by v.actual_at desc nulls last, v.position desc limit 1;
  select app.route_order(array_agg(v.id order by v.position), array_agg(l.lat order by v.position), array_agg(l.lng order by v.position), s_lat, s_lng)
    into ids
    from public.visits v join public.locations l on l.id = v.location_id
   where v.plan_id = p_plan and v.status = 'planned' and l.lat is not null;
  if ids is null then return; end if;
  update public.visits v set position = k + u.n from unnest(ids) with ordinality as u(id, n) where v.id = u.id;
  -- точки без координат — в конец
  update public.visits v set position = k + coalesce(array_length(ids, 1), 0) + s.n
    from (select v2.id, row_number() over (order by v2.position) n from public.visits v2 join public.locations l on l.id = v2.location_id
           where v2.plan_id = p_plan and v2.status = 'planned' and l.lat is null) s
   where v.id = s.id;
end $$;
revoke execute on function app.reorder_plan_nn(uuid) from public, anon;

create or replace function public.auto_plan(p_from date default null, p_per_day int default 15, p_near_m int default 150)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_from date;
  v_today date := (now() at time zone 'Asia/Almaty')::date;
  reps uuid[];
  n int;
  r uuid;
  i int;
  d date;
  cap int;
  existing int;
  v_plan uuid;
  seed record;
  pt record;
  cur_lat double precision;
  cur_lng double precision;
  c_lat double precision;
  c_lng double precision;
  cnt int;
  pos int;
  guard int;
  extra int;
  res jsonb := '{}';
  removed int;
  attached int := 0;
  v_reg boolean;
  cx double precision; cy double precision;
begin
  if auth.uid() is not null and not app.has_perm('assign') then
    raise exception 'Недостаточно прав для автоплана' using errcode = '42501';
  end if;
  if p_per_day < 3 or p_per_day > 15 then raise exception 'Точек в день: от 3 до 15'; end if;
  v_from := app.next_working_day(coalesce(p_from, v_today + 1));
  if v_from < v_today then v_from := app.next_working_day(v_today); end if;

  select array_agg(id order by full_name) into reps from public.profiles where role = 'rep' and is_active and in_autoplan;
  n := coalesce(array_length(reps, 1), 0);
  if n = 0 then raise exception 'Нет торговых представителей, участвующих в автоплане'; end if;

  perform set_config('app.assign_reason', 'Автоплан: распределение по территории', true);

  -- 1. снять будущие автовизиты (перестраиваем заново) и закрыть просроченные автовизиты
  delete from public.visits
   where auto_planned and status = 'planned' and result is null and planned_date >= v_from;
  get diagnostics removed = row_count;
  update public.visits set status = 'cancelled', status_reason = 'Не посещено — перенесено автопланом'
   where auto_planned and status = 'planned' and result is null and planned_date < v_today;

  -- 2. точки для планирования: активные, с координатами, без выполненного визита,
  --    без запланированного визита на сегодня и позже, в пределах 40 км от центра работы
  drop table if exists _pool;
  create temp table _pool on commit drop as
  select l.id, l.lat, l.lng, l.manager_id as owner, false as done, app.is_region(l.city, l.lat, l.lng) as region
    from public.locations l
   where l.archived_at is null
     and l.lat is not null and l.lng is not null
     and l.status_code not in ('closed', 'not_interested', 'client')
     and (l.manager_id is null or l.manager_id = any(reps))
     and not exists (select 1 from public.visits v where v.location_id = l.id and v.status = 'done')
     and not exists (select 1 from public.visits v where v.location_id = l.id and v.status = 'planned' and v.planned_date >= v_today);

  select avg(lat), avg(lng) into cx, cy from _pool;
  delete from _pool where app.km(lat, lng, cx, cy) > 40;

  -- старые незакрытые визиты по этим точкам (просрочены) — закрываем, точка планируется заново
  update public.visits set status = 'cancelled', status_reason = 'Не посещено — перенесено автопланом'
   where status = 'planned' and result is null and planned_date < v_today and location_id in (select id from _pool);

  -- 3. точки «в шаге» от уже запланированных визитов — в тот же день и тому же представителю
  for pt in
    select distinct on (p.id) p.id, v.plan_id, v.manager_id, v.planned_date
      from _pool p
      join public.visits v on v.status = 'planned' and v.planned_date >= v_from and v.plan_id is not null
      join public.locations l on l.id = v.location_id
     where l.lat is not null and app.km(p.lat, p.lng, l.lat, l.lng) * 1000 <= p_near_m
       and v.manager_id = any(reps)
       and (p.owner is null or p.owner = v.manager_id)
     order by p.id, app.km(p.lat, p.lng, l.lat, l.lng)
  loop
    if (select count(*) from public.visits where plan_id = pt.plan_id and status in ('planned', 'done')) < p_per_day then
      update public.locations set manager_id = pt.manager_id where id = pt.id and manager_id is distinct from pt.manager_id;
      insert into public.visits (plan_id, location_id, manager_id, planned_date, position, purpose, auto_planned)
      values (pt.plan_id, pt.id, pt.manager_id, pt.planned_date,
              coalesce((select max(position) from public.visits where plan_id = pt.plan_id), 0) + 1, 'Рядом с точкой плана', true)
      on conflict do nothing;
      delete from _pool where id = pt.id;
      attached := attached + 1;
      perform app.reorder_plan_nn(pt.plan_id);
    end if;
  end loop;

  -- 4. территории: свободные точки делим между представителями поровну и компактно
  drop table if exists _seed;
  create temp table _seed (rep uuid, lat double precision, lng double precision, target int) on commit drop;
  if exists (select 1 from _pool where owner is null) then
    -- центры территорий: самые удалённые друг от друга точки (farthest-point), затем 5 уточнений
    select lat, lng into c_lat, c_lng from _pool order by app.km(lat, lng, cx, cy) desc limit 1;
    insert into _seed (rep, lat, lng) values (null, c_lat, c_lng);
    for i in 2..n loop
      insert into _seed (rep, lat, lng)
      select null, p.lat, p.lng from _pool p
       order by (select min(app.km(p.lat, p.lng, s.lat, s.lng)) from _seed s) desc limit 1;
    end loop;
    -- привязать центры к представителям: ближе к их уже закреплённым точкам
    for i in 1..n loop
      r := reps[i];
      select avg(lat), avg(lng) into c_lat, c_lng from public.locations where manager_id = r and lat is not null and archived_at is null;
      update _seed set rep = r where ctid = (
        select ctid from _seed where rep is null
         order by case when c_lat is null then 0 else app.km(lat, lng, c_lat, c_lng) end limit 1);
    end loop;

    for guard in 1..5 loop
      -- поровну по объёму работы: свободные + уже закреплённые точки в пуле
      update _pool set owner = null where owner is not null and not exists (
        select 1 from public.locations l where l.id = _pool.id and l.manager_id = _pool.owner);
      update _seed s set target = ceil((select count(*) from _pool)::numeric / n)::int
                                 - (select count(*) from _pool p where p.owner = s.rep);
      -- сначала точки с самым явным выбором центра
      for pt in
        select p.id,
               (select array_agg(s.rep order by app.km(p.lat, p.lng, s.lat, s.lng)) from _seed s) as pref
          from _pool p where p.owner is null
         order by (select (array_agg(app.km(p.lat, p.lng, s.lat, s.lng) order by app.km(p.lat, p.lng, s.lat, s.lng)))[2]
                        - min(app.km(p.lat, p.lng, s.lat, s.lng)) from _seed s) desc nulls last
      loop
        for i in 1..n loop
          if (select target from _seed where rep = pt.pref[i]) > 0 or i = n then
            update _pool set owner = pt.pref[i] where id = pt.id;
            update _seed set target = target - 1 where rep = pt.pref[i];
            exit;
          end if;
        end loop;
      end loop;
      exit when guard = 5;
      update _seed s set lat = c.lat, lng = c.lng
        from (select owner, avg(lat) lat, avg(lng) lng from _pool where owner is not null group by owner) c
       where c.owner = s.rep;
    end loop;
  end if;

  -- 5. дни: компактные группы соседних точек, день за днём по ходу территории
  foreach r in array reps loop
    -- старт: последняя запланированная точка представителя или край территории
    select l.lat, l.lng into cur_lat, cur_lng
      from public.visits v join public.locations l on l.id = v.location_id
     where v.manager_id = r and v.status in ('planned', 'done') and l.lat is not null
     order by v.planned_date desc, v.position desc limit 1;
    if cur_lat is null then
      select avg(lat), avg(lng) into c_lat, c_lng from _pool where owner = r;
      select lat, lng into cur_lat, cur_lng from _pool where owner = r order by app.km(lat, lng, c_lat, c_lng) desc limit 1;
    end if;

    d := v_from;
    cnt := 0;
    while exists (select 1 from _pool where owner = r) loop
      d := app.next_working_day(d);
      -- сначала Астана, пригороды и регионы (Косшы и т.п.) — когда в Астане точки закончились
      v_reg := not exists (select 1 from _pool where owner = r and not region);
      select count(*) into existing from public.visits
       where manager_id = r and planned_date = d and status in ('planned', 'done');
      cap := p_per_day - existing;
      if cap < 5 then d := d + 1; continue; end if;

      v_plan := null;
      select id into v_plan from public.visit_plans where manager_id = r and plan_date = d;
      if v_plan is null then
        insert into public.visit_plans (manager_id, plan_date, created_by) values (r, d, null) returning id into v_plan;
      end if;
      select coalesce(max(position), 0) into pos from public.visits where visits.plan_id = v_plan;

      -- первая точка дня — самая дальняя от центра оставшихся: идём от окраин к центру,
      -- чтобы в конце не оставались разбросанные точки
      select avg(lat), avg(lng) into c_lat, c_lng from _pool where owner = r and region = v_reg;
      select p.id, p.lat, p.lng into seed from _pool p where p.owner = r and p.region = v_reg
       order by (select count(*) from _pool q where q.owner = r and q.region = v_reg and q.id <> p.id
                   and app.km(p.lat, p.lng, q.lat, q.lng) <= 2) >= 3 desc,
                app.km(p.lat, p.lng, c_lat, c_lng) desc
       limit 1;
      -- если в этот день уже есть точки (из таблицы или вручную) — добираем рядом с ними
      if existing > 0 then
        select avg(l.lat), avg(l.lng) into c_lat, c_lng from public.visits v join public.locations l on l.id = v.location_id
         where v.manager_id = r and v.planned_date = d and v.status in ('planned', 'done') and l.lat is not null;
        if c_lat is not null then
          select id, lat, lng into seed from _pool where owner = r and region = v_reg order by app.km(lat, lng, c_lat, c_lng) limit 1;
        end if;
      end if;
      cur_lat := seed.lat; cur_lng := seed.lng;
      c_lat := seed.lat; c_lng := seed.lng;
      drop table if exists _day;
      create temp table _day (id uuid, lat double precision, lng double precision, ord serial) on commit drop;
      insert into _day (id, lat, lng) values (seed.id, seed.lat, seed.lng);
      delete from _pool where id = seed.id;

      -- добираем цепочкой: следующая — ближайшая к любой точке дня (район растёт без скачков);
      -- дальше 3 км от всех точек дня не берём, пока есть хоть что-то ближе
      for i in 2..cap loop
        select p.id, p.lat, p.lng into pt from _pool p
         where p.owner = r and p.region = v_reg
         order by (select min(app.km(p.lat, p.lng, x.lat, x.lng)) from _day x) limit 1;
        exit when pt.id is null;
        exit when i > 5 and (select min(app.km(pt.lat, pt.lng, x.lat, x.lng)) from _day x) > case when v_reg then 15 else 3 end;
        insert into _day (id, lat, lng) values (pt.id, pt.lat, pt.lng);
        delete from _pool where id = pt.id;
        pt := null;
      end loop;
      -- точки «в шаге» от точек дня — тоже сегодня, но не сверх лимита дня
      extra := 0;
      for pt in
        select p.id, p.lat, p.lng from _pool p
         where p.owner = r and p.region = v_reg and exists (select 1 from _day x where app.km(p.lat, p.lng, x.lat, x.lng) * 1000 <= p_near_m)
         limit greatest(0, cap - (select count(*) from _day))
      loop
        insert into _day (id, lat, lng) values (pt.id, pt.lat, pt.lng);
        delete from _pool where id = pt.id;
        extra := extra + 1;
      end loop;

      -- порядок объезда: от края района, без возвратов (ближайшая следующая + 2-opt)
      drop table if exists _ord;
      create temp table _ord (id uuid, n int) on commit drop;
      insert into _ord (id, n)
      select u.id, u.n::int from unnest((
        select app.route_order(array_agg(x.id order by x.ord), array_agg(x.lat order by x.ord), array_agg(x.lng order by x.ord), null, null) from _day x
      )) with ordinality as u(id, n);

      update public.locations l set manager_id = r from _ord o where l.id = o.id and l.manager_id is distinct from r;
      insert into public.visits (plan_id, location_id, manager_id, planned_date, position, purpose, auto_planned)
      select v_plan, o.id, r, d, pos + o.n, 'Первичный визит', true from _ord o
      on conflict do nothing;
      if existing > 0 then perform app.reorder_plan_nn(v_plan); end if;
      cnt := cnt + 1;
      d := d + 1;
    end loop;

    res := res || jsonb_build_object(r::text, jsonb_build_object(
      'name', (select full_name from public.profiles where id = r),
      'days', cnt,
      'points', (select count(*) from public.visits where manager_id = r and auto_planned and status = 'planned' and planned_date >= v_from),
      'last_day', (select max(planned_date) from public.visits where manager_id = r and auto_planned and status = 'planned'),
      'avg_km', (select round(avg(km)::numeric, 1) from (
                   select v.plan_id, sum(app.km(l.lat, l.lng, l2.lat, l2.lng)) km
                     from public.visits v join public.locations l on l.id = v.location_id
                     join public.visits v2 on v2.plan_id = v.plan_id and v2.position = (
                       select min(position) from public.visits v3 where v3.plan_id = v.plan_id and v3.position > v.position and v3.status = 'planned')
                     join public.locations l2 on l2.id = v2.location_id
                    where v.manager_id = r and v.status = 'planned' and v.planned_date >= v_from
                    group by v.plan_id) s)
    ));
  end loop;

  perform set_config('app.assign_reason', '', true);
  return jsonb_build_object(
    'from', v_from, 'per_day', p_per_day, 'attached_near', attached, 'removed_old', removed,
    'no_coords', (select count(*) from public.locations l where l.archived_at is null and (l.lat is null or l.lng is null)
                   and not exists (select 1 from public.visits v where v.location_id = l.id and v.status in ('done', 'planned'))),
    'reps', res);
end $$;
revoke execute on function public.auto_plan(date, int, int) from public, anon;
