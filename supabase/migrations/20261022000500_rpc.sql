-- Sillan CRM — 5. Представления и функции, которые вызывает интерфейс.

-- ---------------------------------------------------------------------------
-- Список клиентов (права наследуются от таблиц: security_invoker)
-- ---------------------------------------------------------------------------
create or replace view public.location_list with (security_invoker = true) as
select
  l.id, l.name, l.company_id, c.name as company_name, c.legal_name, c.bin,
  l.client_type, l.status_code, l.country, l.city, l.district,
  coalesce(l.confirmed_address, l.source_address) as address,
  l.confirmed_address is not null as address_confirmed,
  l.lat, l.lng, l.phones, l.website, l.source, l.external_id,
  l.manager_id, p.full_name as manager_name,
  l.last_visit_at, l.next_visit_date, l.next_contact_date,
  l.created_at, l.updated_at, l.archived_at, l.search_text,
  coalesce((select array_agg(ld.direction_id) from public.location_directions ld where ld.location_id = l.id), '{}') as direction_ids,
  pc.full_name as contact_name,
  coalesce(pc.phone, l.phones[1]) as contact_phone
from public.locations l
left join public.companies c on c.id = l.company_id
left join public.profiles p on p.id = l.manager_id
left join lateral (
  select ct.full_name, ct.phone from public.contacts ct
   where ct.location_id = l.id and ct.archived_at is null and ct.is_actual
   order by ct.is_primary desc, ct.created_at
   limit 1
) pc on true;

grant select on public.location_list to authenticated;
revoke all on public.location_list from anon;

-- Значения для фильтров: города и районы из доступных пользователю точек
create or replace function public.location_filter_options() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'cities', coalesce((select jsonb_agg(city order by city) from (
                select distinct city from public.locations where city is not null and archived_at is null) s), '[]'),
    'districts', coalesce((select jsonb_agg(jsonb_build_object('city', city, 'district', district) order by city, district) from (
                select distinct city, district from public.locations
                 where district is not null and archived_at is null) s), '[]')
  )
$$;

-- ---------------------------------------------------------------------------
-- Распределение
-- ---------------------------------------------------------------------------
create or replace function public.assign_locations(p_ids uuid[], p_manager uuid, p_reason text default null)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if not app.has_perm('assign') then
    raise exception 'Недостаточно прав для распределения клиентов' using errcode = '42501';
  end if;
  if p_manager is not null and not exists (select 1 from public.profiles where id = p_manager and is_active) then
    raise exception 'Менеджер не найден или неактивен';
  end if;
  perform set_config('app.assign_reason', coalesce(p_reason, ''), true);
  update public.locations set manager_id = p_manager
   where id = any(p_ids) and manager_id is distinct from p_manager;
  get diagnostics n = row_count;
  perform set_config('app.assign_reason', '', true);
  return n;
end $$;

-- Массовое изменение разрешённых полей
create or replace function public.bulk_update_locations(p_ids uuid[], p_patch jsonb)
returns int language plpgsql security invoker set search_path = public as $$
declare
  n int;
  bad text;
begin
  if not app.has_perm('edit_all') then
    raise exception 'Недостаточно прав для массового изменения' using errcode = '42501';
  end if;
  select k into bad from jsonb_object_keys(p_patch) k
   where k not in ('status_code', 'city', 'district', 'client_type') limit 1;
  if bad is not null then
    raise exception 'Поле % нельзя менять массово', bad;
  end if;
  update public.locations set
    status_code = case when p_patch ? 'status_code' then p_patch->>'status_code' else status_code end,
    city        = case when p_patch ? 'city' then nullif(btrim(p_patch->>'city'), '') else city end,
    district    = case when p_patch ? 'district' then nullif(btrim(p_patch->>'district'), '') else district end,
    client_type = case when p_patch ? 'client_type' then nullif(btrim(p_patch->>'client_type'), '') else client_type end
  where id = any(p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- Правила по территории: сначала предпросмотр, затем явное применение
create or replace function public.territory_preview(p_only_unassigned boolean default true)
returns table (location_id uuid, location_name text, city text, district text,
               current_manager_id uuid, new_manager_id uuid)
language sql stable security invoker set search_path = public as $$
  select l.id, l.name, l.city, l.district, l.manager_id, r.manager_id
    from public.locations l
    join lateral (
      select tr.manager_id from public.territory_rules tr
       where tr.is_active and lower(tr.city) = lower(l.city)
         and (tr.district is null or lower(tr.district) = lower(coalesce(l.district, '')))
       order by (tr.district is not null) desc
       limit 1
    ) r on true
   where l.archived_at is null
     and app.has_perm('assign')
     and l.manager_id is distinct from r.manager_id
     and (not p_only_unassigned or l.manager_id is null)
$$;

create or replace function public.territory_apply(p_only_unassigned boolean default true, p_reason text default null)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if not app.has_perm('assign') then
    raise exception 'Недостаточно прав для распределения клиентов' using errcode = '42501';
  end if;
  perform set_config('app.assign_reason', coalesce(nullif(p_reason, ''), 'Правило территории'), true);
  update public.locations l set manager_id = t.new_manager_id
    from public.territory_preview(p_only_unassigned) t
   where l.id = t.location_id;
  get diagnostics n = row_count;
  perform set_config('app.assign_reason', '', true);
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Планы посещений
-- ---------------------------------------------------------------------------
create or replace function public.ensure_visit_plan(p_manager uuid, p_date date)
returns uuid language plpgsql security invoker set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.visit_plans where manager_id = p_manager and plan_date = p_date;
  if v_id is null then
    insert into public.visit_plans (manager_id, plan_date) values (p_manager, p_date)
    on conflict (manager_id, plan_date) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from public.visit_plans where manager_id = p_manager and plan_date = p_date;
    end if;
  end if;
  return v_id;
end $$;

-- Добавить точки в конец плана. Повторное добавление той же точки игнорируется.
create or replace function public.add_plan_visits(p_plan uuid, p_location_ids uuid[], p_purpose text default null)
returns int language plpgsql security invoker set search_path = public as $$
declare
  p public.visit_plans;
  n int := 0;
  loc uuid;
  pos int;
begin
  select * into p from public.visit_plans where id = p_plan;
  if p.id is null then raise exception 'План не найден'; end if;
  select coalesce(max(position), 0) into pos from public.visits where plan_id = p_plan;
  foreach loc in array p_location_ids loop
    if not exists (select 1 from public.visits where plan_id = p_plan and location_id = loc
                    and status in ('planned', 'done', 'failed')) then
      pos := pos + 1;
      insert into public.visits (plan_id, location_id, manager_id, planned_date, position, purpose)
      values (p_plan, loc, p.manager_id, p.plan_date, pos, nullif(btrim(p_purpose), ''));
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Сохранить порядок точек плана
create or replace function public.reorder_plan_visits(p_plan uuid, p_ids uuid[])
returns void language plpgsql security invoker set search_path = public as $$
begin
  update public.visits v set position = o.ord
    from unnest(p_ids) with ordinality as o(id, ord)
   where v.id = o.id and v.plan_id = p_plan and v.position is distinct from o.ord;
end $$;

-- Завершить визит и сохранить результат
create or replace function public.complete_visit(p_visit uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v public.visits;
  new_status text := coalesce(p_data->>'status', 'done');
  next_date date := nullif(p_data->>'schedule_next_date', '')::date;
  next_plan uuid;
  next_visit uuid;
begin
  select * into v from public.visits where id = p_visit for update;
  if v.id is null then raise exception 'Визит не найден'; end if;
  if not (app.has_perm('edit_all') or (v.manager_id = auth.uid() and app.has_perm('active'))) then
    raise exception 'Недостаточно прав для изменения визита' using errcode = '42501';
  end if;
  if new_status not in ('done', 'failed') then
    raise exception 'Недопустимый статус результата: %', new_status;
  end if;
  if v.status in ('cancelled', 'rescheduled') then
    raise exception 'Визит уже отменён или перенесён';
  end if;

  update public.visits set
    status             = new_status,
    actual_at          = coalesce(nullif(p_data->>'actual_at', '')::timestamptz, actual_at, now()),
    result             = nullif(btrim(p_data->>'result'), ''),
    talked_to          = nullif(btrim(p_data->>'talked_to'), ''),
    contact_id         = app.try_uuid(p_data->>'contact_id'),
    services_note      = nullif(btrim(p_data->>'services_note'), ''),
    equipment_note     = nullif(btrim(p_data->>'equipment_note'), ''),
    needs              = nullif(btrim(p_data->>'needs'), ''),
    interest           = nullif(p_data->>'interest', ''),
    agreements         = nullif(btrim(p_data->>'agreements'), ''),
    objections         = nullif(btrim(p_data->>'objections'), ''),
    next_step          = nullif(btrim(p_data->>'next_step'), ''),
    follow_up_required = coalesce((p_data->>'follow_up_required')::boolean, false),
    next_contact_date  = nullif(p_data->>'next_contact_date', '')::date,
    comment            = nullif(btrim(p_data->>'comment'), ''),
    status_reason      = nullif(btrim(p_data->>'status_reason'), '')
  where id = p_visit;

  if app.can_edit_location(v.location_id) then
    update public.locations set
      next_contact_date = coalesce(nullif(p_data->>'next_contact_date', '')::date, next_contact_date),
      status_code = coalesce(nullif(p_data->>'location_status', ''), status_code)
    where id = v.location_id
      and (nullif(p_data->>'next_contact_date', '') is not null or nullif(p_data->>'location_status', '') is not null);
  end if;

  -- запланировать следующий визит (повторный вызов не создаёт дубль)
  if next_date is not null then
    next_plan := public.ensure_visit_plan(v.manager_id, next_date);
    select id into next_visit from public.visits
     where plan_id = next_plan and location_id = v.location_id and status = 'planned';
    if next_visit is null then
      perform public.add_plan_visits(next_plan, array[v.location_id], nullif(btrim(p_data->>'next_step'), ''));
      select id into next_visit from public.visits
       where plan_id = next_plan and location_id = v.location_id and status = 'planned';
    end if;
  end if;

  return jsonb_build_object('visit_id', p_visit, 'next_visit_id', next_visit);
end $$;

-- Перенести / отменить / отметить «не состоялся»
create or replace function public.set_visit_status(p_visit uuid, p_status text, p_reason text default null,
                                                   p_new_date date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v public.visits;
  new_plan uuid;
  new_visit uuid;
begin
  select * into v from public.visits where id = p_visit for update;
  if v.id is null then raise exception 'Визит не найден'; end if;
  if not (app.has_perm('edit_all') or (v.manager_id = auth.uid() and app.has_perm('active'))) then
    raise exception 'Недостаточно прав для изменения визита' using errcode = '42501';
  end if;
  if p_status not in ('planned', 'rescheduled', 'cancelled', 'failed') then
    raise exception 'Недопустимый статус: %', p_status;
  end if;

  if p_status = 'rescheduled' then
    if v.status = 'rescheduled' then return v.rescheduled_to; end if;   -- повторное нажатие
    if p_new_date is null then raise exception 'Укажите новую дату визита'; end if;
    if v.status <> 'planned' then raise exception 'Перенести можно только запланированный визит'; end if;
    new_plan := public.ensure_visit_plan(v.manager_id, p_new_date);
    select id into new_visit from public.visits
     where plan_id = new_plan and location_id = v.location_id and status = 'planned';
    if new_visit is null then
      insert into public.visits (plan_id, location_id, manager_id, planned_date, position, purpose, prep_notes)
      values (new_plan, v.location_id, v.manager_id, p_new_date,
              coalesce((select max(position) from public.visits where plan_id = new_plan), 0) + 1,
              v.purpose, v.prep_notes)
      returning id into new_visit;
    end if;
    update public.visits set status = 'rescheduled', rescheduled_to = new_visit,
                             status_reason = nullif(btrim(p_reason), '')
     where id = p_visit;
    return new_visit;
  end if;

  if p_status = 'planned' and v.status = 'done' then
    raise exception 'Проведённый визит нельзя вернуть в план';
  end if;
  update public.visits set status = p_status, status_reason = nullif(btrim(p_reason), '')
   where id = p_visit;
  return p_visit;
end $$;

-- ---------------------------------------------------------------------------
-- Заявки: смена статуса с комментарием в истории
-- ---------------------------------------------------------------------------
create or replace function public.change_request_status(p_request uuid, p_status text, p_comment text default null)
returns void language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  if not exists (select 1 from public.request_statuses where code = p_status and is_active) then
    raise exception 'Неизвестный статус заявки';
  end if;
  perform set_config('app.status_comment', coalesce(p_comment, ''), true);
  update public.requests set status_code = p_status where id = p_request and status_code <> p_status;
  get diagnostics n = row_count;
  perform set_config('app.status_comment', '', true);
  if n = 0 and not exists (select 1 from public.requests where id = p_request) then
    raise exception 'Заявка не найдена или нет прав' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Уведомления
-- ---------------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns int language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  update public.notifications set is_read = true
   where user_id = auth.uid() and not is_read and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Глобальный поиск (по данным, доступным пользователю)
-- ---------------------------------------------------------------------------
create or replace function public.global_search(p_q text, p_limit int default 8)
returns table (kind text, id uuid, title text, subtitle text)
language plpgsql stable security invoker set search_path = public as $$
declare
  q text := lower(btrim(coalesce(p_q, '')));
  digits text := app.norm_phone(p_q);
  pat text;
  dpat text;
begin
  if length(q) < 2 then return; end if;
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- телефон: «8 701 123-45-67» и «+7(701)1234567» ищутся одинаково
  dpat := case when digits is not null and length(regexp_replace(q, '[\d\s()+\-]', '', 'g')) = 0
                    and length(digits) >= 4
               then '%' || case when length(digits) >= 10 then digits else regexp_replace(q, '\D', '', 'g') end || '%' end;

  return query
  (select 'location'::text, l.id, l.name,
          concat_ws(', ', l.city, coalesce(l.confirmed_address, l.source_address))
     from public.locations l
    where l.archived_at is null and (l.search_text like pat or (dpat is not null and l.search_text like dpat))
    order by l.name limit p_limit)
  union all
  (select 'company', c.id, c.name, concat_ws(' · ', c.legal_name, c.bin)
     from public.companies c
    where c.archived_at is null
      and (lower(c.name) like pat or lower(coalesce(c.legal_name, '')) like pat or coalesce(c.bin, '') like pat)
    order by c.name limit p_limit)
  union all
  (select 'request', r.id, r.number || ' — ' || r.item_name, l.name
     from public.requests r join public.locations l on l.id = r.location_id
    where lower(r.number) like pat or lower(r.item_name) like pat or lower(coalesce(r.article, '')) like pat
    order by r.created_at desc limit p_limit)
  union all
  (select 'equipment', e.location_id, e.name || coalesce(' ' || e.model, ''), l.name
     from public.location_equipment e join public.locations l on l.id = e.location_id
    where e.archived_at is null and (lower(e.name) like pat or lower(coalesce(e.model, '')) like pat)
    order by e.name limit p_limit);
end $$;

-- ---------------------------------------------------------------------------
-- Импорт: поиск совпадений с базой
--   external — тот же внешний ID источника (точное совпадение);
--   exact    — то же название + город + адрес (точное совпадение);
--   possible — совпал телефон или название в том же городе: решает пользователь.
-- ---------------------------------------------------------------------------
create or replace function public.import_preview(p_source text, p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare res jsonb;
begin
  if not app.has_perm('import') then
    raise exception 'Недостаточно прав для импорта' using errcode = '42501';
  end if;
  with r as (
    select x.row, x.name, x.city, x.address, x.external_id,
           app.norm_text(x.name) as n, app.norm_text(x.city) as c, app.norm_address(x.address) as a,
           app.norm_phones(coalesce(array(select jsonb_array_elements_text(x.phones)), '{}')) as ph
      from jsonb_to_recordset(p_rows) as x("row" int, name text, city text, address text,
                                            external_id text, phones jsonb)
  ),
  m as (
    select r.*,
      (select l.id from public.locations l
        where r.external_id is not null and l.source = p_source and l.external_id = r.external_id) as ext_id,
      (select array_agg(l.id) from public.locations l
        where r.a is not null and l.name_norm = r.n and l.city_norm is not distinct from r.c
          and l.address_norm = r.a) as exact_ids
    from r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'row', m.row,
      'key', concat_ws('|', m.n, m.c, m.a),
      'match', case when m.ext_id is not null then 'external'
                    when cardinality(m.exact_ids) = 1 then 'exact' end,
      'location_id', coalesce(m.ext_id, case when cardinality(m.exact_ids) = 1 then m.exact_ids[1] end),
      'possible', case when m.ext_id is null and coalesce(cardinality(m.exact_ids), 0) <> 1 then
        (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', p.id, 'name', p.name, 'city', p.city,
                  'address', coalesce(p.confirmed_address, p.source_address),
                  'phones', p.phones, 'reason', p.reason)), '[]')
           from (select l.*, case
                   when l.phones_norm && m.ph and l.name_norm = m.n then 'Совпали телефон и название'
                   when l.phones_norm && m.ph then 'Совпал телефон'
                   when l.address_norm = m.a then 'Совпали название и адрес'
                   else 'Совпало название в том же городе' end as reason
                   from public.locations l
                  where l.archived_at is null
                    and ((cardinality(m.ph) > 0 and l.phones_norm && m.ph)
                         or (l.name_norm = m.n and l.city_norm is not distinct from m.c))
                  order by (l.phones_norm && m.ph) desc, l.created_at
                  limit 5) p)
        else '[]'::jsonb end
    ) order by m.row), '[]')
    into res
    from m;
  return res;
end $$;

-- Найти или создать компанию (юрлицо) при импорте
create or replace function app.import_company(p_name text, p_legal text, p_bin text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
  v_bin text := nullif(regexp_replace(coalesce(p_bin, ''), '\D', '', 'g'), '');
begin
  if v_bin is not null and length(v_bin) <> 12 then v_bin := null; end if;
  if v_bin is not null then
    select id into v_id from public.companies where bin = v_bin;
  end if;
  if v_id is null and nullif(btrim(coalesce(p_name, '')), '') is not null then
    select id into v_id from public.companies where name_norm = app.norm_text(p_name) and archived_at is null
     order by created_at limit 1;
  end if;
  if v_id is null and coalesce(nullif(btrim(p_name), ''), nullif(btrim(p_legal), '')) is not null then
    insert into public.companies (name, legal_name, bin)
    values (coalesce(nullif(btrim(p_name), ''), btrim(p_legal)), nullif(btrim(p_legal), ''), v_bin)
    returning id into v_id;
  elsif v_id is not null then
    update public.companies set
      legal_name = coalesce(legal_name, nullif(btrim(p_legal), '')),
      bin = coalesce(bin, v_bin)
    where id = v_id and (legal_name is null or bin is null);
  end if;
  return v_id;
end $$;

-- Применить порцию строк импорта (каждая строка — отдельная подтранзакция)
--  row.action: create | update (перезаписать разрешённые поля непустыми значениями)
--            | merge (дописать только пустые поля) | skip | conflict
create or replace function public.import_apply_batch(p_job uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  job public.import_jobs;
  r jsonb;
  d jsonb;
  act text;
  loc uuid;
  comp uuid;
  existing public.locations;
  v_phones text[];
  dir uuid;
  f text[];
  c_created int := 0; c_updated int := 0; c_skipped int := 0; c_conflict int := 0; c_error int := 0;
  msg text;
begin
  if not app.has_perm('import') then
    raise exception 'Недостаточно прав для импорта' using errcode = '42501';
  end if;
  select * into job from public.import_jobs where id = p_job for update;
  if job.id is null then raise exception 'Задание импорта не найдено'; end if;
  if job.status <> 'processing' then raise exception 'Импорт уже завершён'; end if;
  f := job.update_fields;
  perform set_config('app.import_ctx', 'on', true);

  for r in select * from jsonb_array_elements(p_rows) loop
    -- повторная отправка той же порции не обрабатывает строку второй раз
    if exists (select 1 from public.import_rows where job_id = p_job and row_number = (r->>'row')::int) then
      continue;
    end if;
    act := coalesce(r->>'action', 'skip');
    d := coalesce(r->'data', '{}');
    loc := app.try_uuid(r->>'location_id');
    msg := nullif(r->>'message', '');
    v_phones := coalesce(array(select btrim(x) from jsonb_array_elements_text(d->'phones') x where btrim(x) <> ''), '{}');
    begin
      -- защита от дублей при повторном импорте, даже если клиент прислал устаревшее решение
      if act = 'create' then
        select l.id into loc from public.locations l
         where (nullif(d->>'external_id', '') is not null and l.source = job.source and l.external_id = d->>'external_id')
            or (app.norm_address(d->>'address') is not null and l.name_norm = app.norm_text(d->>'name')
                and l.city_norm is not distinct from app.norm_text(d->>'city')
                and l.address_norm = app.norm_address(d->>'address'))
         limit 1;
        if loc is not null then
          act := case job.mode when 'update_allowed' then 'update' else 'skip' end;
          msg := coalesce(msg, 'Уже есть в базе');
        end if;
      end if;
      if act = 'update' and job.mode <> 'update_allowed' then
        act := 'skip';
        msg := coalesce(msg, 'Уже есть в базе (режим без обновления)');
      end if;

      if act = 'create' then
        if nullif(btrim(d->>'name'), '') is null then
          raise exception 'Не заполнено название';
        end if;
        comp := app.import_company(d->>'company_name', d->>'legal_name', d->>'bin');
        insert into public.locations (company_id, name, city, district, source_address, lat, lng, phones, website,
                                      source, source_url, external_id, source_category,
                                      last_import_at, last_import_job_id, manager_id)
        values (comp, btrim(d->>'name'), nullif(btrim(d->>'city'), ''), nullif(btrim(d->>'district'), ''),
                nullif(btrim(d->>'address'), ''), (d->>'lat')::double precision, (d->>'lng')::double precision,
                v_phones, nullif(btrim(d->>'website'), ''), job.source, nullif(btrim(d->>'source_url'), ''),
                nullif(btrim(d->>'external_id'), ''), nullif(btrim(d->>'category'), ''),
                now(), p_job, null)
        returning id into loc;
        for dir in select app.try_uuid(x) from jsonb_array_elements_text(coalesce(d->'direction_ids', '[]')) x loop
          insert into public.location_directions (location_id, direction_id, source)
          values (loc, dir, 'import') on conflict do nothing;
        end loop;
        insert into public.import_rows (job_id, row_number, action, location_id, message, raw)
        values (p_job, (r->>'row')::int, 'created', loc, msg, r->'raw');
        c_created := c_created + 1;

      elsif act in ('update', 'merge') then
        select * into existing from public.locations where id = loc for update;
        if existing.id is null then raise exception 'Запись для обновления не найдена'; end if;
        if act = 'update' then
          -- перезапись только выбранных полей и только непустыми значениями
          update public.locations set
            name            = case when 'name' = any(f) then coalesce(nullif(btrim(d->>'name'), ''), name) else name end,
            city            = case when 'city' = any(f) then coalesce(nullif(btrim(d->>'city'), ''), city) else city end,
            district        = case when 'district' = any(f) then coalesce(nullif(btrim(d->>'district'), ''), district) else district end,
            source_address  = case when 'address' = any(f) then coalesce(nullif(btrim(d->>'address'), ''), source_address) else source_address end,
            website         = case when 'website' = any(f) then coalesce(nullif(btrim(d->>'website'), ''), website) else website end,
            lat             = case when 'coords' = any(f) and (d->>'lat') is not null and (d->>'lng') is not null then (d->>'lat')::double precision else lat end,
            lng             = case when 'coords' = any(f) and (d->>'lat') is not null and (d->>'lng') is not null then (d->>'lng')::double precision else lng end,
            source_url      = case when 'source_url' = any(f) then coalesce(nullif(btrim(d->>'source_url'), ''), source_url) else source_url end,
            source_category = case when 'category' = any(f) then coalesce(nullif(btrim(d->>'category'), ''), source_category) else source_category end,
            phones          = case when 'phones' = any(f) then
                                (select coalesce(array_agg(p order by ord), '{}') from (
                                   select distinct on (app.norm_phone(p)) p, ord
                                     from unnest(existing.phones || v_phones) with ordinality u(p, ord)
                                    order by app.norm_phone(p), ord) s)
                              else phones end,
            external_id     = coalesce(external_id, nullif(btrim(d->>'external_id'), '')),
            last_import_at  = now(),
            last_import_job_id = p_job
          where id = loc;
        else
          -- объединение с найденной записью: дописываем только пустые поля
          update public.locations set
            city            = coalesce(city, nullif(btrim(d->>'city'), '')),
            district        = coalesce(district, nullif(btrim(d->>'district'), '')),
            source_address  = coalesce(source_address, nullif(btrim(d->>'address'), '')),
            website         = coalesce(website, nullif(btrim(d->>'website'), '')),
            lat             = coalesce(lat, (d->>'lat')::double precision),
            lng             = coalesce(lng, (d->>'lng')::double precision),
            source_url      = coalesce(source_url, nullif(btrim(d->>'source_url'), '')),
            source_category = coalesce(source_category, nullif(btrim(d->>'category'), '')),
            phones          = (select coalesce(array_agg(p order by ord), '{}') from (
                                 select distinct on (app.norm_phone(p)) p, ord
                                   from unnest(existing.phones || v_phones) with ordinality u(p, ord)
                                  order by app.norm_phone(p), ord) s),
            external_id     = coalesce(external_id, nullif(btrim(d->>'external_id'), '')),
            last_import_at  = now(),
            last_import_job_id = p_job
          where id = loc;
        end if;
        if act = 'merge' or 'directions' = any(f) then
          for dir in select app.try_uuid(x) from jsonb_array_elements_text(coalesce(d->'direction_ids', '[]')) x loop
            insert into public.location_directions (location_id, direction_id, source)
            values (loc, dir, 'import') on conflict do nothing;
          end loop;
        end if;
        if existing.company_id is null and nullif(btrim(coalesce(d->>'company_name', d->>'legal_name', '')), '') is not null then
          comp := app.import_company(d->>'company_name', d->>'legal_name', d->>'bin');
          update public.locations set company_id = comp where id = loc;
        end if;
        insert into public.import_rows (job_id, row_number, action, location_id, message, raw)
        values (p_job, (r->>'row')::int, 'updated', loc,
                coalesce(msg, case when act = 'merge' then 'Объединено с существующей записью' end), r->'raw');
        c_updated := c_updated + 1;

      elsif act = 'conflict' then
        insert into public.import_rows (job_id, row_number, action, location_id, message, raw)
        values (p_job, (r->>'row')::int, 'conflict', loc, coalesce(msg, 'Возможный дубликат — решение не принято'), r->'raw');
        c_conflict := c_conflict + 1;

      elsif act = 'error' then
        insert into public.import_rows (job_id, row_number, action, message, raw)
        values (p_job, (r->>'row')::int, 'error', coalesce(msg, 'Ошибка в строке'), r->'raw');
        c_error := c_error + 1;

      else
        insert into public.import_rows (job_id, row_number, action, location_id, message, raw)
        values (p_job, (r->>'row')::int, 'skipped', loc, msg, r->'raw');
        c_skipped := c_skipped + 1;
      end if;
    exception when others then
      insert into public.import_rows (job_id, row_number, action, message, raw)
      values (p_job, (r->>'row')::int, 'error', left(sqlerrm, 500), r->'raw')
      on conflict (job_id, row_number) do nothing;
      c_error := c_error + 1;
    end;
  end loop;

  perform set_config('app.import_ctx', '', true);
  update public.import_jobs set
    created_count = created_count + c_created,
    updated_count = updated_count + c_updated,
    skipped_count = skipped_count + c_skipped,
    conflict_count = conflict_count + c_conflict,
    error_count = error_count + c_error
  where id = p_job;

  return jsonb_build_object('created', c_created, 'updated', c_updated, 'skipped', c_skipped,
                            'conflict', c_conflict, 'error', c_error);
end $$;

create or replace function public.import_finish(p_job uuid, p_failed boolean default false)
returns public.import_jobs language plpgsql security definer set search_path = public as $$
declare job public.import_jobs;
begin
  if not app.has_perm('import') then
    raise exception 'Недостаточно прав для импорта' using errcode = '42501';
  end if;
  update public.import_jobs set
    status = case when p_failed then 'failed' when error_count > 0 then 'partial' else 'done' end,
    finished_at = now()
  where id = p_job and status = 'processing'
  returning * into job;
  if job.id is null then select * into job from public.import_jobs where id = p_job; end if;
  return job;
end $$;

-- ---------------------------------------------------------------------------
-- Дашборд. Все показатели считаются по реальным записям и правам пользователя.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_stats(
  p_from date, p_to date, p_manager uuid default null, p_city text default null, p_direction uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare res jsonb;
  today date := (now() at time zone 'Asia/Almaty')::date;
begin
  with loc as (
    select l.* from public.locations l
     where l.archived_at is null
       and (p_manager is null or l.manager_id = p_manager)
       and (p_city is null or l.city = p_city)
       and (p_direction is null or exists (select 1 from public.location_directions ld
                                            where ld.location_id = l.id and ld.direction_id = p_direction))
  ),
  vis as (
    select v.* from public.visits v join loc on loc.id = v.location_id
     where p_manager is null or v.manager_id = p_manager
  ),
  req as (
    select r.*, s.is_final from public.requests r
      join loc on loc.id = r.location_id
      join public.request_statuses s on s.code = r.status_code
  ),
  dl as (
    select d.*, st.kind from public.deals d
      join loc on loc.id = d.location_id
      join public.deal_stages st on st.code = d.stage_code
     where p_manager is null or d.manager_id = p_manager
  )
  select jsonb_build_object(
    'companies_total', (select count(distinct company_id) from loc where company_id is not null),
    'locations_total', (select count(*) from loc),
    'locations_new', (select count(*) from loc where created_at::date between p_from and p_to),
    'locations_unassigned', (select count(*) from loc where manager_id is null),
    'by_direction', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'count', x.cnt) order by d.sort, d.name), '[]')
                       from public.directions d
                       left join lateral (select count(*) cnt from public.location_directions ld
                                           join loc on loc.id = ld.location_id where ld.direction_id = d.id) x on true
                      where d.is_active),
    'without_direction', (select count(*) from loc where not exists (select 1 from public.location_directions ld where ld.location_id = loc.id)),
    'by_city', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(city, 'Не указан'), 'count', cnt) order by cnt desc), '[]')
                  from (select city, count(*) cnt from loc group by city order by count(*) desc limit 15) s),
    'by_manager', (select coalesce(jsonb_agg(jsonb_build_object('id', manager_id, 'name', coalesce(p.full_name, 'Без ответственного'), 'count', cnt) order by cnt desc), '[]')
                     from (select manager_id, count(*) cnt from loc group by manager_id) s
                     left join public.profiles p on p.id = s.manager_id),
    'visits_today', (select count(*) from vis where planned_date = today and status = 'planned'),
    'visits_done', (select count(*) from vis where status = 'done' and (actual_at at time zone 'Asia/Almaty')::date between p_from and p_to),
    'visits_planned_period', (select count(*) from vis where planned_date between p_from and p_to and status <> 'rescheduled'),
    'overdue_visits', (select count(*) from vis where status = 'planned' and planned_date < today),
    'overdue_contacts', (select count(*) from loc where next_contact_date < today
                           and not exists (select 1 from public.visits v2 where v2.location_id = loc.id
                                            and v2.status = 'planned' and v2.planned_date >= loc.next_contact_date)),
    'overdue_deals', (select count(*) from dl where kind = 'open' and next_action_date < today),
    'requests_new', (select count(*) from req where status_code = 'new'),
    'requests_in_work', (select count(*) from req where status_code <> 'new' and not is_final),
    'requests_created_period', (select count(*) from req where created_at::date between p_from and p_to),
    'deals_open', (select count(*) from dl where kind = 'open'),
    'deals_open_amount', (select coalesce(sum(amount), 0) from dl where kind = 'open'),
    'deals_by_stage', (select coalesce(jsonb_agg(jsonb_build_object('code', st.code, 'name', st.name, 'kind', st.kind,
                                     'count', coalesce(x.cnt, 0), 'amount', coalesce(x.amt, 0)) order by st.sort), '[]')
                         from public.deal_stages st
                         left join lateral (select count(*) cnt, sum(amount) amt from dl where dl.stage_code = st.code) x on true
                        where st.is_active)
  ) into res;
  return res;
end $$;

-- Показатели по каждому менеджеру за период
create or replace function public.manager_stats(
  p_from date, p_to date, p_city text default null, p_direction uuid default null)
returns table (manager_id uuid, manager_name text, role text, assigned_clients bigint, visits_planned bigint,
               visits_done bigint, visits_failed bigint, contacted_clients bigint, requests_created bigint,
               deals_created bigint, deals_open_amount numeric, overdue_actions bigint)
language plpgsql stable security invoker set search_path = public as $$
declare today date := (now() at time zone 'Asia/Almaty')::date;
begin
  return query
  with loc as (
    select l.* from public.locations l
     where l.archived_at is null
       and (p_city is null or l.city = p_city)
       and (p_direction is null or exists (select 1 from public.location_directions ld
                                            where ld.location_id = l.id and ld.direction_id = p_direction))
  ),
  people as (
    select p.id, p.full_name, p.role from public.profiles p
     where p.is_active and (app.has_perm('view_team') or p.id = auth.uid())
       and (p.role = 'rep' or exists (select 1 from loc where loc.manager_id = p.id)
            or exists (select 1 from public.visits v where v.manager_id = p.id))
  )
  select pe.id, pe.full_name, pe.role,
    (select count(*) from loc where loc.manager_id = pe.id),
    (select count(*) from public.visits v join loc on loc.id = v.location_id
      where v.manager_id = pe.id and v.planned_date between p_from and p_to and v.status <> 'rescheduled'),
    (select count(*) from public.visits v join loc on loc.id = v.location_id
      where v.manager_id = pe.id and v.status = 'done' and (v.actual_at at time zone 'Asia/Almaty')::date between p_from and p_to),
    (select count(*) from public.visits v join loc on loc.id = v.location_id
      where v.manager_id = pe.id and v.status = 'failed' and v.planned_date between p_from and p_to),
    (select count(distinct v.location_id) from public.visits v join loc on loc.id = v.location_id
      where v.manager_id = pe.id and v.status = 'done' and (v.actual_at at time zone 'Asia/Almaty')::date between p_from and p_to),
    (select count(*) from public.requests r join loc on loc.id = r.location_id
      where r.initiator_id = pe.id and r.created_at::date between p_from and p_to),
    (select count(*) from public.deals d join loc on loc.id = d.location_id
      where d.manager_id = pe.id and d.created_at::date between p_from and p_to),
    (select coalesce(sum(d.amount), 0) from public.deals d join loc on loc.id = d.location_id
       join public.deal_stages st on st.code = d.stage_code
      where d.manager_id = pe.id and st.kind = 'open'),
    (select count(*) from public.visits v join loc on loc.id = v.location_id
      where v.manager_id = pe.id and v.status = 'planned' and v.planned_date < today)
    + (select count(*) from public.deals d join loc on loc.id = d.location_id
         join public.deal_stages st on st.code = d.stage_code
        where d.manager_id = pe.id and st.kind = 'open' and d.next_action_date < today)
    + (select count(*) from loc where loc.manager_id = pe.id and loc.next_contact_date < today
         and not exists (select 1 from public.visits v2 where v2.location_id = loc.id
                          and v2.status = 'planned' and v2.planned_date >= loc.next_contact_date))
  from people pe
  order by pe.full_name;
end $$;

revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
