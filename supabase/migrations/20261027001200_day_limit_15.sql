-- Sillan CRM — 12. Жёсткий лимит: не больше 15 точек в день у торгового представителя
-- (автоплан, ручное добавление в план, перенос визита на другой день).

create or replace function app.visits_day_limit() returns trigger
language plpgsql as $$
declare
  n int;
begin
  if new.status not in ('planned', 'done') or new.manager_id is null or new.planned_date is null then
    return new;
  end if;
  -- визит уже стоял в этом дне (например, отмечают выполненным) — не проверяем
  if tg_op = 'UPDATE' and old.status in ('planned', 'done')
     and old.manager_id is not distinct from new.manager_id and old.planned_date is not distinct from new.planned_date then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('visits_day:' || new.manager_id::text || new.planned_date::text));
  select count(*) into n from public.visits
   where manager_id = new.manager_id and planned_date = new.planned_date
     and status in ('planned', 'done') and id is distinct from new.id;
  if n >= 15 then
    raise exception 'На % у представителя уже 15 точек — это максимум в день', to_char(new.planned_date, 'DD.MM.YYYY')
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists visits_day_limit on public.visits;
create trigger visits_day_limit before insert or update of status, manager_id, planned_date on public.visits
  for each row execute function app.visits_day_limit();
revoke execute on function app.visits_day_limit() from public, anon;

-- Дни, где уже больше 15 точек (с завтрашнего): лишние незакрытые визиты — самые дальние
-- от центра маршрута дня — снимаются; автоплан ставит эти точки на другие дни.
do $$
declare
  v_today date := (now() at time zone 'Asia/Almaty')::date;
  pl record;
begin
  create temp table _over on commit drop as
  select v.id, v.plan_id
    from public.visits v
    join public.locations l on l.id = v.location_id
    join (select v2.manager_id, v2.planned_date, count(*) total,
                 avg(l2.lat) clat, avg(l2.lng) clng
            from public.visits v2 join public.locations l2 on l2.id = v2.location_id
           where v2.status in ('planned', 'done') and v2.planned_date > v_today
           group by v2.manager_id, v2.planned_date
          having count(*) > 15) d on d.manager_id = v.manager_id and d.planned_date = v.planned_date
   where v.status = 'planned' and v.result is null
     and v.id in (
       select x.id from (
         select v3.id,
                row_number() over (order by case when l3.lat is null then 1e9
                                                 else app.km(l3.lat, l3.lng, d.clat, d.clng) end desc) rn
           from public.visits v3 join public.locations l3 on l3.id = v3.location_id
          where v3.manager_id = d.manager_id and v3.planned_date = d.planned_date
            and v3.status = 'planned' and v3.result is null) x
        where x.rn <= d.total - 15);
  delete from public.visits where id in (select id from _over);
  for pl in select distinct plan_id from _over where plan_id is not null loop
    perform app.reorder_plan_nn(pl.plan_id);
  end loop;
end $$;

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
  select l.id, l.lat, l.lng, l.manager_id as owner, false as done
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
      select avg(lat), avg(lng) into c_lat, c_lng from _pool where owner = r;
      select id, lat, lng into seed from _pool where owner = r order by app.km(lat, lng, c_lat, c_lng) desc limit 1;
      -- если в этот день уже есть точки (из таблицы или вручную) — добираем рядом с ними
      if existing > 0 then
        select avg(l.lat), avg(l.lng) into c_lat, c_lng from public.visits v join public.locations l on l.id = v.location_id
         where v.manager_id = r and v.planned_date = d and v.status in ('planned', 'done') and l.lat is not null;
        if c_lat is not null then
          select id, lat, lng into seed from _pool where owner = r order by app.km(lat, lng, c_lat, c_lng) limit 1;
        end if;
      end if;
      cur_lat := seed.lat; cur_lng := seed.lng;
      c_lat := seed.lat; c_lng := seed.lng;
      drop table if exists _day;
      create temp table _day (id uuid, lat double precision, lng double precision, ord serial) on commit drop;
      insert into _day (id, lat, lng) values (seed.id, seed.lat, seed.lng);
      delete from _pool where id = seed.id;

      -- добираем ближайшие к центру группы
      for i in 2..cap loop
        select id, lat, lng into pt from _pool where owner = r order by app.km(lat, lng, c_lat, c_lng) limit 1;
        exit when pt.id is null;
        insert into _day (id, lat, lng) values (pt.id, pt.lat, pt.lng);
        delete from _pool where id = pt.id;
        select avg(lat), avg(lng) into c_lat, c_lng from _day;
        pt := null;
      end loop;
      -- точки «в шаге» от точек дня — тоже сегодня, но не сверх лимита дня
      extra := 0;
      for pt in
        select p.id, p.lat, p.lng from _pool p
         where p.owner = r and exists (select 1 from _day x where app.km(p.lat, p.lng, x.lat, x.lng) * 1000 <= p_near_m)
         limit greatest(0, cap - (select count(*) from _day))
      loop
        insert into _day (id, lat, lng) values (pt.id, pt.lat, pt.lng);
        delete from _pool where id = pt.id;
        extra := extra + 1;
      end loop;

      -- порядок объезда: от ближайшей к месту, где закончили, к ближайшей следующей
      drop table if exists _ord;
      create temp table _ord (id uuid, n int) on commit drop;
      for i in 1..(select count(*) from _day) loop
        select x.id, x.lat, x.lng into pt from _day x
         where not exists (select 1 from _ord o where o.id = x.id)
         order by app.km(x.lat, x.lng, cur_lat, cur_lng) limit 1;
        insert into _ord values (pt.id, i);
        cur_lat := pt.lat; cur_lng := pt.lng;
      end loop;

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
