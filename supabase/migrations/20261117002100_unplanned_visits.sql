-- Sillan CRM — 21. Визит без плана: торговый сам приехал на точку (или добавил новую) —
-- работа засчитывается: визит встаёт в его план на сегодня (сверх лимита 15).
-- Плюс объединение дублей точек (контакты, фото, оборудование переносятся в одну карточку).

create or replace function public.start_unplanned_visit(p_location uuid, p_done boolean default false, p_note text default null)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_today date := (now() at time zone 'Etc/GMT-5')::date;
  v_plan uuid;
  v_visit uuid;
  v_pos int;
begin
  if auth.uid() is null or not app.has_perm('active') then
    raise exception 'Не выполнен вход' using errcode = '42501';
  end if;
  if not app.can_view_location(p_location) then
    raise exception 'Точка не найдена' using errcode = '42501';
  end if;

  v_plan := public.ensure_visit_plan(auth.uid(), v_today);
  -- уже есть визит к этой точке сегодня — используем его
  select id into v_visit from public.visits
   where manager_id = auth.uid() and planned_date = v_today and location_id = p_location and status in ('planned', 'done')
   order by status = 'done' desc limit 1;
  if v_visit is null then
    select coalesce(max(position), 0) + 1 into v_pos from public.visits where plan_id = v_plan;
    perform set_config('app.found_point', 'on', true);
    insert into public.visits (plan_id, location_id, manager_id, planned_date, position, purpose)
    values (v_plan, p_location, auth.uid(), v_today, v_pos, 'Визит без плана')
    returning id into v_visit;
    perform set_config('app.found_point', '', true);
  end if;
  if p_done then
    update public.visits
       set status = 'done', actual_at = coalesce(actual_at, now()),
           result = coalesce(result, nullif(btrim(p_note), ''), 'Визит без плана')
     where id = v_visit and status = 'planned';
  end if;
  return v_visit;
end $$;
revoke execute on function public.start_unplanned_visit(uuid, boolean, text) from public, anon;
grant execute on function public.start_unplanned_visit(uuid, boolean, text) to authenticated;

-- Объединить дубль p_from в точку p_into: всё полезное переносится, дубль уходит в архив
create or replace function app.merge_location(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public as $$
declare f record;
begin
  select * into f from public.locations where id = p_from;
  if f.id is null or p_from = p_into then return; end if;
  update public.contacts set location_id = p_into where location_id = p_from;
  update public.location_photos set location_id = p_into where location_id = p_from;
  update public.location_equipment set location_id = p_into where location_id = p_from;
  insert into public.location_directions (location_id, direction_id)
    select p_into, direction_id from public.location_directions where location_id = p_from on conflict do nothing;
  insert into public.location_services (location_id, service_id)
    select p_into, service_id from public.location_services where location_id = p_from on conflict do nothing;
  update public.comments set location_id = p_into where location_id = p_from;
  update public.requests set location_id = p_into where location_id = p_from;
  update public.visits set location_id = p_into where location_id = p_from;
  update public.locations i set
    phones = (select array_agg(distinct x) from unnest(coalesce(i.phones, '{}') || coalesce(f.phones, '{}')) x),
    company_id = coalesce(i.company_id, f.company_id),
    confirmed_address = coalesce(nullif(i.confirmed_address, ''), nullif(f.confirmed_address, '')),
    lat = coalesce(i.lat, f.lat), lng = coalesce(i.lng, f.lng),
    posts_count = coalesce(i.posts_count, f.posts_count),
    segment = coalesce(i.segment, f.segment),
    manager_id = coalesce(f.manager_id, i.manager_id),
    status_code = case when i.status_code = 'new' then f.status_code else i.status_code end
  where i.id = p_into;
  perform set_config('app.own_archive', 'on', true);
  update public.locations set archived_at = now() where id = p_from;
  perform set_config('app.own_archive', '', true);
  insert into public.comments (location_id, body)
  values (p_into, 'Объединено с дублем «' || f.name || '», добавленным вручную ' || to_char(f.created_at, 'DD.MM.YYYY'));
end $$;
revoke execute on function app.merge_location(uuid, uuid) from public, anon;
