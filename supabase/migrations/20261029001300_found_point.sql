-- Sillan CRM — 13. Новая точка, найденная по пути: торговый сам добавляет её в «Клиенты»
-- и в план дня (сверх лимита 15 — это не планирование, а фактический заезд).

create or replace function app.visits_day_limit() returns trigger
language plpgsql as $$
declare
  n int;
begin
  -- новая точка, найденная по пути, добавляется к дню сверх лимита
  if coalesce(current_setting('app.found_point', true), '') = 'on' then
    return new;
  end if;
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
revoke execute on function app.visits_day_limit() from public, anon;

create or replace function public.add_found_point(p_manager uuid, p_date date, p jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_loc uuid;
  v_plan uuid;
  v_visit uuid;
  v_existed boolean := false;
  v_lat double precision := nullif(p->>'lat', '')::double precision;
  v_lng double precision := nullif(p->>'lng', '')::double precision;
  v_phone text := nullif(btrim(p->>'phone'), '');
  v_pos int;
begin
  if auth.uid() is null or not app.has_perm('active') then
    raise exception 'Не выполнен вход' using errcode = '42501';
  end if;
  if p_manager is distinct from auth.uid() and not app.has_perm('edit_all') then
    raise exception 'Добавлять точки можно только в свой план' using errcode = '42501';
  end if;
  if nullif(btrim(p->>'name'), '') is null then raise exception 'Укажите название точки'; end if;
  if v_lat is not null and (v_lat not between -90 and 90 or v_lng not between -180 and 180) then
    raise exception 'Неверные координаты';
  end if;

  -- уже есть в базе: то же название рядом (до 150 м) или тот же телефон
  select id into v_loc from public.locations
   where archived_at is null
     and ((v_lat is not null and lat is not null and name_norm = app.norm_text(p->>'name') and app.km(lat, lng, v_lat, v_lng) < 0.15)
       or (v_phone is not null and app.norm_phone(v_phone) = any(phones_norm)))
   order by case when v_lat is not null and lat is not null then app.km(lat, lng, v_lat, v_lng) end nulls last
   limit 1;

  if v_loc is not null then
    v_existed := true;
  else
    v_loc := public.create_location(jsonb_build_object(
      'client_request_id', p->>'client_request_id',
      'name', p->>'name', 'city', coalesce(nullif(btrim(p->>'city'), ''), 'Астана'), 'address', p->>'address',
      'phones', case when v_phone is null then '[]'::jsonb else jsonb_build_array(v_phone) end,
      'manager_id', p_manager, 'status_code', 'new',
      'comment', 'Новая точка — найдена по пути ' || to_char(p_date, 'DD.MM.YYYY'),
      'contact', case when nullif(btrim(p->>'contact_name'), '') is not null
                      then jsonb_build_object('full_name', p->>'contact_name', 'phone', v_phone) end));
    update public.locations set lat = v_lat, lng = v_lng where id = v_loc and v_lat is not null;
  end if;

  v_plan := public.ensure_visit_plan(p_manager, p_date);
  select id into v_visit from public.visits
   where plan_id = v_plan and location_id = v_loc and status in ('planned', 'done', 'failed') limit 1;
  if v_visit is null then
    select coalesce(max(position), 0) + 1 into v_pos from public.visits where plan_id = v_plan;
    perform set_config('app.found_point', 'on', true);
    insert into public.visits (plan_id, location_id, manager_id, planned_date, position, purpose)
    values (v_plan, v_loc, p_manager, p_date, v_pos, 'Новая точка по пути')
    returning id into v_visit;
    perform set_config('app.found_point', '', true);
  end if;
  return jsonb_build_object('location_id', v_loc, 'visit_id', v_visit, 'existed', v_existed);
end $$;
revoke execute on function public.add_found_point(uuid, date, jsonb) from public, anon;
grant execute on function public.add_found_point(uuid, date, jsonb) to authenticated;
