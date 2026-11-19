-- Sillan CRM — 27. Торговый не заводит вторую карточку точки, которая уже есть в базе.
-- При «Новом клиенте» CRM ищет похожие точки во всей базе (в том числе закреплённые за другим торговым):
-- то же название по тому же адресу / рядом с местом, где стоит торговый, или тот же телефон.
-- Кнопка «Это она — я на месте» забирает точку себе и засчитывает визит — без дубля.

create or replace function public.find_existing_points(p_name text, p_address text default null,
  p_lat double precision default null, p_lng double precision default null, p_phones text[] default null)
returns table (id uuid, name text, address text, meters int, manager_name text, visited boolean, mine boolean)
language sql stable security definer set search_path = public as $$
  with q as (select app.norm_phones(p_phones) ph)
  select l.id, l.name, coalesce(l.confirmed_address, l.source_address),
         case when p_lat is not null and l.lat is not null then round(app.km(l.lat, l.lng, p_lat, p_lng) * 1000)::int end,
         (select coalesce(p.full_name, '') from public.profiles p where p.id = l.manager_id),
         exists (select 1 from public.visits v where v.location_id = l.id and v.status = 'done'),
         l.manager_id is not distinct from auth.uid()
    from public.locations l, q
   where auth.uid() is not null and app.has_perm('active')
     and l.archived_at is null
     and (
       (length(btrim(coalesce(p_name, ''))) >= 2 and app.same_brand(l.name, p_name) and (
          (nullif(btrim(p_address), '') is not null
             and app.addr_house(coalesce(l.confirmed_address, l.source_address)) = app.addr_house(p_address)
             and extensions.similarity(app.addr_street(coalesce(l.confirmed_address, l.source_address)), app.addr_street(p_address)) >= 0.4)
          or (p_lat is not null and l.lat is not null and app.km(l.lat, l.lng, p_lat, p_lng) <= 0.3)))
       or (cardinality(q.ph) > 0 and l.phones_norm && q.ph)
     )
   order by 4 nulls last, l.name
   limit 5
$$;
revoke execute on function public.find_existing_points(text, text, double precision, double precision, text[]) from public, anon;
grant execute on function public.find_existing_points(text, text, double precision, double precision, text[]) to authenticated;

-- смена ответственного торговым — только через claim_location (флаг app.claim_ctx)
create or replace function app.locations_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    -- торговый представитель может создать точку только на себя
    if not app.has_perm('assign') and auth.uid() is not null
       and coalesce(current_setting('app.import_ctx', true), '') <> 'on' then
      new.manager_id := auth.uid();
    end if;
  else
    if new.manager_id is distinct from old.manager_id
       and auth.uid() is not null and not app.has_perm('assign')
       and coalesce(current_setting('app.claim_ctx', true), '') <> 'on' then
      raise exception 'Недостаточно прав для смены ответственного менеджера' using errcode = '42501';
    end if;
    if new.archived_at is distinct from old.archived_at
       and auth.uid() is not null and not app.has_perm('archive')
       and coalesce(current_setting('app.own_archive', true), '') <> 'on' then
      raise exception 'Недостаточно прав для архивирования клиента' using errcode = '42501';
    end if;
  end if;
  -- generated-колонки ещё не вычислены в BEFORE-триггере, поэтому телефоны нормализуем сами
  new.search_text := app.location_search_text(new) || ' ' || array_to_string(app.norm_phones(new.phones), ' ');
  return new;
end $$;

-- Торговый на месте: точка из базы (даже чужая) становится его, чужие будущие визиты в неё снимаются
create or replace function public.claim_location(p_location uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Etc/GMT-5')::date;
begin
  if auth.uid() is null or not app.has_perm('active') then
    raise exception 'Не выполнен вход' using errcode = '42501';
  end if;
  if not exists (select 1 from public.locations where id = p_location and archived_at is null) then
    raise exception 'Точка не найдена';
  end if;
  if exists (select 1 from public.locations where id = p_location and manager_id is not distinct from auth.uid()) then
    return;
  end if;
  perform set_config('app.assign_reason', 'Торговый на месте отметил точку из базы', true);
  perform set_config('app.claim_ctx', 'on', true);
  update public.locations set manager_id = auth.uid() where id = p_location;
  perform set_config('app.claim_ctx', '', true);
  perform set_config('app.assign_reason', '', true);
  update public.visits set status = 'cancelled', status_reason = 'Точку посетил другой торговый'
   where location_id = p_location and status = 'planned' and manager_id <> auth.uid() and planned_date >= v_today;
end $$;
revoke execute on function public.claim_location(uuid) from public, anon;
grant execute on function public.claim_location(uuid) to authenticated;
