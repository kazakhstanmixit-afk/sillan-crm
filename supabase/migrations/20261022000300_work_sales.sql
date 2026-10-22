-- Sillan CRM — 3. Планы посещений и визиты, заявки, потенциальные сделки, уведомления,
-- журнал импорта, журнал действий.

-- ---------------------------------------------------------------------------
-- Планы посещений и визиты
-- ---------------------------------------------------------------------------

create table public.visit_plans (
  id         uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.profiles(id) on delete cascade,
  plan_date  date not null,
  notes      text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_id, plan_date)
);
create trigger visit_plans_touch before update on public.visit_plans
  for each row execute function app.touch_updated_at();

create table public.visits (
  id                 uuid primary key default gen_random_uuid(),
  plan_id            uuid references public.visit_plans(id) on delete set null,
  location_id        uuid not null references public.locations(id) on delete cascade,
  manager_id         uuid not null references public.profiles(id),
  planned_date       date not null,
  position           int not null default 0,
  purpose            text,
  prep_notes         text,
  status             text not null default 'planned'
                     check (status in ('planned', 'done', 'rescheduled', 'cancelled', 'failed')),
  actual_at          timestamptz,
  result             text,
  talked_to          text,
  contact_id         uuid references public.contacts(id) on delete set null,
  services_note      text,
  equipment_note     text,
  needs              text,
  interest           text check (interest in ('none', 'low', 'medium', 'high')),
  agreements         text,
  objections         text,
  next_step          text,
  follow_up_required boolean not null default false,
  next_contact_date  date,
  comment            text,
  status_reason      text,
  rescheduled_to     uuid references public.visits(id) on delete set null,
  client_request_id  uuid unique,       -- защита от повторной отправки
  created_by         uuid references public.profiles(id) default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint visits_done_has_time check (status <> 'done' or actual_at is not null)
);
-- одна и та же точка не может дважды стоять в одном плане (кроме отменённых/перенесённых)
create unique index visits_plan_location_uq on public.visits (plan_id, location_id)
  where plan_id is not null and status in ('planned', 'done', 'failed');
create index visits_location_idx on public.visits (location_id, planned_date desc);
create index visits_manager_date_idx on public.visits (manager_id, planned_date);
create index visits_plan_idx on public.visits (plan_id, position);
create index visits_status_idx on public.visits (status, planned_date);
create trigger visits_touch before update on public.visits
  for each row execute function app.touch_updated_at();

alter table public.location_photos
  add constraint location_photos_visit_fk foreign key (visit_id) references public.visits(id) on delete set null;

-- Пересчёт дат последнего/следующего визита в карточке клиента
create or replace function app.refresh_location_visit_dates(p_location uuid) returns void
language plpgsql security definer set search_path = public as $$
declare prev text := coalesce(current_setting('app.system_update', true), '');
begin
  perform set_config('app.system_update', 'on', true);
  update public.locations l set
    last_visit_at = (select max(v.actual_at) from public.visits v
                      where v.location_id = l.id and v.status = 'done'),
    next_visit_date = (select min(v.planned_date) from public.visits v
                        where v.location_id = l.id and v.status = 'planned')
  where l.id = p_location;
  perform set_config('app.system_update', prev, true);
end $$;

create or replace function app.visits_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform app.refresh_location_visit_dates(old.location_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.location_id <> old.location_id
       or new.status <> old.status or new.planned_date <> old.planned_date
       or new.actual_at is distinct from old.actual_at) then
    perform app.refresh_location_visit_dates(new.location_id);
  end if;
  return null;
end $$;

create trigger visits_after_write after insert or update or delete on public.visits
  for each row execute function app.visits_after_write();

-- Визит в плане всегда принадлежит владельцу плана и дате плана
create or replace function app.visits_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.visit_plans;
begin
  if new.plan_id is not null then
    select * into p from public.visit_plans where id = new.plan_id;
    new.manager_id := p.manager_id;
    new.planned_date := p.plan_date;
  end if;
  if new.status = 'done' and new.actual_at is null then
    new.actual_at := now();
  end if;
  return new;
end $$;

create trigger visits_before_write before insert or update on public.visits
  for each row execute function app.visits_before_write();

-- ---------------------------------------------------------------------------
-- Заявки в отделы
-- ---------------------------------------------------------------------------

create sequence public.request_equipment_seq;
create sequence public.request_parts_seq;

create table public.requests (
  id                uuid primary key default gen_random_uuid(),
  number            text unique,
  kind              text not null check (kind in ('equipment', 'parts')),
  location_id       uuid not null references public.locations(id) on delete restrict,
  contact_id        uuid references public.contacts(id) on delete set null,
  visit_id          uuid references public.visits(id) on delete set null,
  initiator_id      uuid not null references public.profiles(id) default auth.uid(),
  assignee_id       uuid references public.profiles(id) on delete set null,
  assignee_name     text,             -- сотрудник отдела без учётной записи
  status_code       text not null default 'new' references public.request_statuses(code) on update cascade,
  urgency           text not null default 'normal' check (urgency in ('low', 'normal', 'high', 'urgent')),
  -- оборудование
  category_id       uuid references public.equipment_categories(id) on delete set null,
  item_name         text not null check (length(btrim(item_name)) > 0), -- оборудование/решение или название запчасти
  brand             text,
  model             text,
  article           text,             -- артикул запчасти
  quantity          int not null default 1 check (quantity > 0),
  budget            numeric(14, 2) check (budget is null or budget >= 0),
  description       text,
  comment           text,
  client_request_id uuid unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  closed_at         timestamptz
);
create index requests_location_idx on public.requests (location_id);
create index requests_status_idx on public.requests (status_code, created_at desc);
create index requests_initiator_idx on public.requests (initiator_id);
create index requests_assignee_idx on public.requests (assignee_id);
create trigger requests_touch before update on public.requests
  for each row execute function app.touch_updated_at();

create table public.request_status_history (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests(id) on delete cascade,
  from_status text,
  to_status   text not null,
  comment     text,
  changed_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index request_status_history_req_idx on public.request_status_history (request_id, created_at);

create table public.request_comments (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  body       text not null check (length(btrim(body)) > 0),
  author_id  uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index request_comments_req_idx on public.request_comments (request_id, created_at);

create table public.request_attachments (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.requests(id) on delete cascade,
  storage_path text not null unique,
  file_name    text,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now()
);
create index request_attachments_req_idx on public.request_attachments (request_id);

create or replace function app.requests_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare final boolean;
begin
  if tg_op = 'INSERT' then
    new.number := case new.kind
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

create trigger requests_before_write before insert or update on public.requests
  for each row execute function app.requests_before_write();

-- ---------------------------------------------------------------------------
-- Потенциальные сделки
-- ---------------------------------------------------------------------------

create table public.deals (
  id                  uuid primary key default gen_random_uuid(),
  location_id         uuid not null references public.locations(id) on delete restrict,
  manager_id          uuid not null references public.profiles(id) default auth.uid(),
  title               text not null check (length(btrim(title)) > 0),
  product             text,
  amount              numeric(14, 2) check (amount is null or amount >= 0),  -- предполагаемая сумма, НЕ выручка
  stage_code          text not null default 'need' references public.deal_stages(code) on update cascade,
  probability         int check (probability is null or probability between 0 and 100),
  expected_close_date date,
  source              text,
  visit_id            uuid references public.visits(id) on delete set null,
  request_id          uuid references public.requests(id) on delete set null,
  next_step           text,
  next_action_date    date,
  lost_reason         text,
  comment             text,
  client_request_id   uuid unique,
  created_by          uuid references public.profiles(id) default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  closed_at           timestamptz,
  constraint deals_lost_reason check (stage_code <> 'lost' or nullif(btrim(lost_reason), '') is not null)
);
create index deals_location_idx on public.deals (location_id);
create index deals_manager_idx on public.deals (manager_id, stage_code);
create trigger deals_touch before update on public.deals
  for each row execute function app.touch_updated_at();

create or replace function app.deals_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  select kind into k from public.deal_stages where code = new.stage_code;
  new.closed_at := case when k in ('won', 'lost') then coalesce(new.closed_at, now()) else null end;
  if tg_op = 'UPDATE' and new.manager_id is distinct from old.manager_id
     and auth.uid() is not null and not app.has_perm('assign') then
    raise exception 'Недостаточно прав для смены ответственного по сделке' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null and not app.has_perm('assign') then
    new.manager_id := auth.uid();
  end if;
  return new;
end $$;

create trigger deals_before_write before insert or update on public.deals
  for each row execute function app.deals_before_write();

-- ---------------------------------------------------------------------------
-- Уведомления внутри CRM
-- ---------------------------------------------------------------------------

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  link       text,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, is_read, created_at desc);

create or replace function app.notify(p_user uuid, p_kind text, p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind, title, body, link)
  select p_user, p_kind, p_title, p_body, p_link
  where p_user is not null and p_user is distinct from auth.uid()
    and exists (select 1 from public.profiles where id = p_user and is_active)
$$;

create or replace function app.requests_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  loc_name text;
  st_name  text;
  kind_ru  text := case new.kind when 'equipment' then 'оборудование' else 'запчасти' end;
  u record;
begin
  select name into loc_name from public.locations where id = new.location_id;
  if tg_op = 'INSERT' then
    insert into public.request_status_history (request_id, from_status, to_status, changed_by)
    values (new.id, null, new.status_code, auth.uid());
    -- ответственному и руководству
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

create trigger requests_after_write after insert or update on public.requests
  for each row execute function app.requests_after_write();

-- ---------------------------------------------------------------------------
-- Импорт
-- ---------------------------------------------------------------------------

create table public.import_jobs (
  id             uuid primary key default gen_random_uuid(),
  file_name      text not null,
  sheet_name     text,
  source         text not null default '2gis',
  mode           text not null check (mode in ('add_new', 'update_allowed', 'skip_existing')),
  update_fields  text[] not null default '{}',
  mapping        jsonb not null default '{}',
  status         text not null default 'processing' check (status in ('processing', 'done', 'partial', 'failed')),
  total_rows     int not null default 0,
  created_count  int not null default 0,
  updated_count  int not null default 0,
  skipped_count  int not null default 0,
  conflict_count int not null default 0,
  error_count    int not null default 0,
  created_by     uuid references public.profiles(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create table public.import_rows (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.import_jobs(id) on delete cascade,
  row_number  int not null,
  action      text not null check (action in ('created', 'updated', 'skipped', 'conflict', 'error')),
  location_id uuid references public.locations(id) on delete set null,
  message     text,
  raw         jsonb,
  created_at  timestamptz not null default now(),
  unique (job_id, row_number)
);
create index import_rows_job_idx on public.import_rows (job_id, action);

-- ---------------------------------------------------------------------------
-- Журнал действий (аудит)
-- ---------------------------------------------------------------------------

create table public.activity_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles(id) on delete set null,
  entity      text not null,
  entity_id   uuid,
  location_id uuid,
  action      text not null,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index activity_logs_location_idx on public.activity_logs (location_id, created_at desc);
create index activity_logs_entity_idx on public.activity_logs (entity, entity_id);
create index activity_logs_created_idx on public.activity_logs (created_at desc);

create or replace function app.audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  d jsonb := '{}';
  k text;
  skip text[] := array['updated_at', 'search_text', 'phones_norm', 'name_norm', 'city_norm',
                       'address_norm', 'phone_norm', 'whatsapp_norm', 'last_visit_at', 'next_visit_date'];
  act text := lower(tg_op);
  rec jsonb := coalesce(n, o);
begin
  if coalesce(current_setting('app.system_update', true), '') = 'on' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      if not k = any(skip) and (n->k) is distinct from (o->k) then
        d := d || jsonb_build_object(k, jsonb_build_object('from', o->k, 'to', n->k));
      end if;
    end loop;
    if d = '{}' then return null; end if;
    if d ? 'archived_at' then
      act := case when n->>'archived_at' is null then 'restore' else 'archive' end;
    end if;
  elsif tg_op = 'INSERT' then
    d := jsonb_strip_nulls(jsonb_build_object('name', n->>'name', 'full_name', n->>'full_name',
                                              'title', n->>'title', 'item_name', n->>'item_name'));
  elsif tg_op = 'DELETE' then
    d := o;
  end if;
  insert into public.activity_logs (actor_id, entity, entity_id, location_id, action, details)
  values (auth.uid(), tg_table_name, app.try_uuid(rec->>'id'),
          case when tg_table_name = 'locations' then app.try_uuid(rec->>'id')
               else app.try_uuid(rec->>'location_id') end,
          act, d);
  return null;
end $$;

create trigger audit_companies after insert or update or delete on public.companies for each row execute function app.audit();
create trigger audit_locations after insert or update or delete on public.locations for each row execute function app.audit();
create trigger audit_contacts after insert or update or delete on public.contacts for each row execute function app.audit();
create trigger audit_equipment after insert or update or delete on public.location_equipment for each row execute function app.audit();
create trigger audit_photos after insert or delete on public.location_photos for each row execute function app.audit();
create trigger audit_comments after update or delete on public.comments for each row execute function app.audit();
create trigger audit_visits after update or delete on public.visits for each row execute function app.audit();
create trigger audit_requests after update or delete on public.requests for each row execute function app.audit();
create trigger audit_deals after insert or update or delete on public.deals for each row execute function app.audit();
create trigger audit_profiles after update on public.profiles for each row execute function app.audit();

create or replace function app.audit_links() returns trigger
language plpgsql security definer set search_path = public as $$
declare rec record := coalesce(new, old);
  ref_name text;
begin
  if coalesce(current_setting('app.system_update', true), '') = 'on' then return null; end if;
  if tg_table_name = 'location_directions' then
    select name into ref_name from public.directions where id = rec.direction_id;
  else
    select name into ref_name from public.services where id = rec.service_id;
  end if;
  insert into public.activity_logs (actor_id, entity, location_id, action, details)
  values (auth.uid(), tg_table_name, rec.location_id, lower(tg_op), jsonb_build_object('name', ref_name));
  return null;
end $$;

create trigger audit_location_directions after insert or delete on public.location_directions for each row execute function app.audit_links();
create trigger audit_location_services after insert or delete on public.location_services for each row execute function app.audit_links();
