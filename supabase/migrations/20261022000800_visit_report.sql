-- Sillan CRM — 8. Отчёт о визите одной формой, обращение в сервисный отдел, справочники брендов и услуг.
-- Выполнить ОДИН раз в Supabase → SQL Editor (если базовые миграции уже применены).

-- ---------------------------------------------------------------------------
-- Заявки: три отдела — сервис (ремонт/обслуживание), запчасти, продажа оборудования
-- ---------------------------------------------------------------------------
alter table public.requests drop constraint if exists requests_kind_check;
alter table public.requests add constraint requests_kind_check check (kind in ('service', 'parts', 'equipment'));
create sequence if not exists public.request_service_seq;

create or replace function app.requests_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare final boolean;
begin
  if tg_op = 'INSERT' then
    new.number := case new.kind
      when 'service' then 'СР-' || lpad(nextval('public.request_service_seq')::text, 6, '0')
      when 'equipment' then 'ОБ-' || lpad(nextval('public.request_equipment_seq')::text, 6, '0')
      else 'ЗЧ-' || lpad(nextval('public.request_parts_seq')::text, 6, '0') end;
    if auth.uid() is not null then new.initiator_id := auth.uid(); end if;
  else
    new.number := old.number;
    new.kind := old.kind;
    new.initiator_id := old.initiator_id;
  end if;
  select is_final into final from public.request_statuses where code = new.status_code;
  new.closed_at := case when final then coalesce(new.closed_at, now()) else null end;
  return new;
end $$;

create or replace function app.requests_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  loc_name text;
  st_name  text;
  kind_ru  text := case new.kind when 'service' then 'сервис' when 'equipment' then 'покупку оборудования' else 'запчасти' end;
  u record;
begin
  select name into loc_name from public.locations where id = new.location_id;
  if tg_op = 'INSERT' then
    insert into public.request_status_history (request_id, from_status, to_status, changed_by)
    values (new.id, null, new.status_code, auth.uid());
    perform app.notify(new.assignee_id, 'request_new', 'Новая заявка ' || new.number,
                       'Заявка на ' || kind_ru || ': ' || new.item_name || ' — ' || coalesce(loc_name, ''),
                       '/requests/' || new.id);
    for u in select id from public.profiles where is_active and role in ('admin', 'head')
               and id is distinct from new.assignee_id loop
      perform app.notify(u.id, 'request_new', 'Новая заявка ' || new.number,
                         'Заявка на ' || kind_ru || ': ' || new.item_name || ' — ' || coalesce(loc_name, ''),
                         '/requests/' || new.id);
    end loop;
  elsif new.status_code is distinct from old.status_code then
    insert into public.request_status_history (request_id, from_status, to_status, comment, changed_by)
    values (new.id, old.status_code, new.status_code,
            nullif(current_setting('app.status_comment', true), ''), auth.uid());
    select name into st_name from public.request_statuses where code = new.status_code;
    perform app.notify(new.initiator_id, 'request_status', 'Заявка ' || new.number || ': ' || st_name,
                       coalesce(loc_name, ''), '/requests/' || new.id);
    perform app.notify(new.assignee_id, 'request_status', 'Заявка ' || new.number || ': ' || st_name,
                       coalesce(loc_name, ''), '/requests/' || new.id);
  elsif new.assignee_id is distinct from old.assignee_id then
    perform app.notify(new.assignee_id, 'request_assigned', 'Вам назначена заявка ' || new.number,
                       new.item_name || ' — ' || coalesce(loc_name, ''), '/requests/' || new.id);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Визит: планы развития сервиса (расширение, будущие заказы)
-- ---------------------------------------------------------------------------
alter table public.visits add column if not exists expansion_plans text;

-- ---------------------------------------------------------------------------
-- Справочники: бренды оборудования (Sillan первым) и услуги как в условиях
-- ---------------------------------------------------------------------------
insert into public.equipment_brands (name)
select b from unnest(array['Sillan', 'Launch', 'Hunter', 'Bosch', 'Sivik', 'Nordberg', 'Trommelberg', 'Werther', 'Hofmann',
  'Corghi', 'Ravaglioli', 'Autel', 'Remeza', 'Fini', 'Atis', 'Техно Вектор', 'Kraftwell', 'TopAuto', 'Comec', 'Space', 'Другой']) b
on conflict do nothing;

update public.services set name = 'Ходовая часть'
 where name = 'Ремонт подвески' and not exists (select 1 from public.services where name = 'Ходовая часть');
update public.services set name = 'Мотористы (ремонт двигателя)'
 where name = 'Ремонт двигателя' and not exists (select 1 from public.services where name = 'Мотористы (ремонт двигателя)');
update public.services set name = 'Продажа автозапчастей'
 where name = 'Продажа запчастей' and not exists (select 1 from public.services where name = 'Продажа автозапчастей');
insert into public.services (name, sort, direction_id)
select s.name, s.sort, (select id from public.directions d where d.name = s.dir)
from (values ('Автоэлектрик', 45, 'Компьютерная диагностика'), ('Ремонт АКПП', 25, 'Автосервис / СТО'),
             ('Тормозная система', 115, 'Проточка тормозных дисков')) as s(name, sort, dir)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Сохранить отчёт о визите одной транзакцией: результат визита, данные карточки
-- (название, юрлицо, адрес, ЛПР, посты, услуги, оборудование с брендами),
-- планы развития и заявки в отделы. Повторное сохранение не создаёт дублей.
-- ---------------------------------------------------------------------------
create or replace function public.save_visit_report(p_visit uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v public.visits;
  res jsonb;
  loc public.locations;
  c jsonb := coalesce(p_data->'card', '{}');
  lpr jsonb := coalesce(c->'lpr', '{}');
  e jsonb;
  r jsonb;
  comp uuid;
  ct uuid;
  eq uuid;
  req_id uuid;
  reqs jsonb := '[]';
  plans text := nullif(btrim(p_data->>'expansion_plans'), '');
begin
  -- результат визита (там же проверка прав и планирование следующего визита)
  res := public.complete_visit(p_visit, p_data);
  select * into v from public.visits where id = p_visit;
  update public.visits set expansion_plans = plans where id = p_visit;

  if app.can_edit_location(v.location_id) then
    select * into loc from public.locations where id = v.location_id for update;

    update public.locations set
      name              = coalesce(nullif(btrim(c->>'name'), ''), name),
      confirmed_address = coalesce(nullif(btrim(c->>'address'), ''), confirmed_address),
      posts_count       = case when c ? 'posts_count' and nullif(c->>'posts_count', '') is not null
                               then (c->>'posts_count')::int else posts_count end
    where id = loc.id;

    -- юрлицо
    if nullif(btrim(c->>'legal_name'), '') is not null or nullif(btrim(c->>'bin'), '') is not null then
      if loc.company_id is null then
        comp := app.import_company(coalesce(nullif(btrim(c->>'legal_name'), ''), loc.name), c->>'legal_name', c->>'bin');
        update public.locations set company_id = comp where id = loc.id;
      else
        update public.companies set
          legal_name = coalesce(nullif(btrim(c->>'legal_name'), ''), legal_name),
          bin = coalesce(nullif(regexp_replace(coalesce(c->>'bin', ''), '\D', '', 'g'), ''), bin)
        where id = loc.company_id;
      end if;
    end if;

    -- ЛПР: обновляем существующего или добавляем
    if coalesce(nullif(btrim(lpr->>'full_name'), ''), nullif(btrim(lpr->>'phone'), ''), nullif(btrim(lpr->>'whatsapp'), '')) is not null then
      select id into ct from public.contacts
       where location_id = loc.id and archived_at is null and decision_role = 'decision_maker'
       order by is_primary desc, created_at limit 1;
      if ct is null then
        insert into public.contacts (location_id, full_name, position, phone, whatsapp, decision_role, is_primary)
        values (loc.id, nullif(btrim(lpr->>'full_name'), ''), nullif(btrim(lpr->>'position'), ''),
                nullif(btrim(lpr->>'phone'), ''), nullif(btrim(lpr->>'whatsapp'), ''), 'decision_maker', true);
      else
        update public.contacts set
          full_name = coalesce(nullif(btrim(lpr->>'full_name'), ''), full_name),
          position  = coalesce(nullif(btrim(lpr->>'position'), ''), position),
          phone     = coalesce(nullif(btrim(lpr->>'phone'), ''), phone),
          whatsapp  = coalesce(nullif(btrim(lpr->>'whatsapp'), ''), whatsapp),
          is_actual = true
        where id = ct;
      end if;
    end if;

    -- услуги (полный набор отмеченных)
    if jsonb_typeof(c->'service_ids') = 'array' then
      delete from public.location_services where location_id = loc.id
        and service_id <> all(array(select app.try_uuid(x) from jsonb_array_elements_text(c->'service_ids') x));
      insert into public.location_services (location_id, service_id)
      select loc.id, app.try_uuid(x) from jsonb_array_elements_text(c->'service_ids') x
      where app.try_uuid(x) is not null
      on conflict do nothing;
    end if;

    -- оборудование: по каждой отмеченной категории — бренд и количество (снятые галочки ничего не удаляют)
    for e in select * from jsonb_array_elements(coalesce(c->'equipment', '[]')) loop
      eq := null;
      select id into eq from public.location_equipment
       where location_id = loc.id and archived_at is null and category_id = app.try_uuid(e->>'category_id')
       order by created_at limit 1;
      if eq is null then
        insert into public.location_equipment (location_id, category_id, brand_id, name, quantity)
        values (loc.id, app.try_uuid(e->>'category_id'), app.try_uuid(e->>'brand_id'),
                coalesce(nullif(btrim(e->>'name'), ''), (select name from public.equipment_categories where id = app.try_uuid(e->>'category_id')), 'Оборудование'),
                greatest(coalesce(nullif(e->>'quantity', '')::int, 1), 1));
      else
        update public.location_equipment set
          brand_id = coalesce(app.try_uuid(e->>'brand_id'), brand_id),
          quantity = coalesce(greatest(nullif(e->>'quantity', '')::int, 1), quantity)
        where id = eq;
      end if;
    end loop;

    -- планы развития — в комментарии карточки (без повторов при пересохранении)
    if plans is not null and not exists (select 1 from public.comments where location_id = loc.id and kind = 'expansion' and body = plans) then
      insert into public.comments (location_id, kind, body) values (loc.id, 'expansion', plans);
    end if;
  end if;

  -- заявки в отделы
  for r in select * from jsonb_array_elements(coalesce(p_data->'requests', '[]')) loop
    if not app.can_view_location(v.location_id) then
      raise exception 'Недостаточно прав для создания заявки' using errcode = '42501';
    end if;
    if nullif(btrim(r->>'item_name'), '') is null then
      raise exception 'Заполните, что требуется, в заявке';
    end if;
    req_id := null;
    select id into req_id from public.requests where client_request_id = app.try_uuid(r->>'client_request_id');
    if req_id is null then
      insert into public.requests (kind, location_id, visit_id, contact_id, item_name, category_id, brand, model, article,
                                   quantity, budget, urgency, description, comment, client_request_id)
      values (r->>'kind', v.location_id, v.id, app.try_uuid(r->>'contact_id'), btrim(r->>'item_name'),
              app.try_uuid(r->>'category_id'), nullif(btrim(r->>'brand'), ''), nullif(btrim(r->>'model'), ''),
              nullif(btrim(r->>'article'), ''), greatest(coalesce(nullif(r->>'quantity', '')::int, 1), 1),
              nullif(r->>'budget', '')::numeric, coalesce(nullif(r->>'urgency', ''), 'normal'),
              nullif(btrim(r->>'description'), ''), nullif(btrim(r->>'comment'), ''), app.try_uuid(r->>'client_request_id'))
      returning id into req_id;
    end if;
    reqs := reqs || jsonb_build_array((select jsonb_build_object('id', id, 'number', number, 'kind', kind) from public.requests where id = req_id));
  end loop;

  return res || jsonb_build_object('requests', reqs);
end $$;

revoke execute on function public.save_visit_report(uuid, jsonb) from public, anon;
grant execute on function public.save_visit_report(uuid, jsonb) to authenticated;
