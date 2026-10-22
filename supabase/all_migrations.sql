-- Sillan CRM: все миграции одним файлом. Сгенерировано scripts/bundle-sql.mjs — не редактируйте вручную.
-- Выполняйте только на новом, пустом проекте Supabase. Для обновлений используйте отдельные файлы из supabase/migrations.

-- ===== 20261022000100_core.sql =====
-- Sillan CRM — 1. Основа: расширения, служебная схема app, пользователи и права, справочники.

create extension if not exists pg_trgm with schema extensions;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Нормализация (одинаковые правила используются в импорте и в поиске)
-- ---------------------------------------------------------------------------

-- Телефон: только цифры, казахстанский формат приводится к 7XXXXXXXXXX.
create or replace function app.norm_phone(p text) returns text
language sql immutable parallel safe as $$
  select case
    when d = '' then null
    when length(d) = 11 and left(d, 1) = '8' then '7' || substr(d, 2)
    when length(d) = 10 then '7' || d
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s
$$;

create or replace function app.norm_phones(p text[]) returns text[]
language sql immutable parallel safe as $$
  select coalesce(array_agg(distinct n order by n), '{}')
  from unnest(coalesce(p, '{}')) as x, app.norm_phone(x) as n
  where n is not null and length(n) >= 6
$$;

-- Текст: нижний регистр, ё→е, всё кроме букв и цифр → пробел.
create or replace function app.norm_text(p text) returns text
language sql immutable parallel safe as $$
  select nullif(btrim(regexp_replace(replace(lower(coalesce(p, '')), 'ё', 'е'), '[^[:alnum:]]+', ' ', 'g')), '')
$$;

-- Адрес: как текст, плюс убираются служебные слова (ул., пр., д., г. и т.п.).
create or replace function app.norm_address(p text) returns text
language sql immutable parallel safe as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(app.norm_text(p),
             '(^| )(ул|улица|пр|просп|проспект|пр т|прт|мкр|микрорайон|д|дом|г|город|кв|офис|оф|здание|зд|строение|стр|к|корпус|район|р н)(?= |$)',
             ' ', 'g'),
           ' +', ' ', 'g')), '')
$$;

create or replace function app.try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  -- служебные пересчёты (даты визитов, поисковая строка) не считаются «изменением карточки»
  if coalesce(current_setting('app.system_update', true), '') = 'on' then
    return new;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Пользователи
-- ---------------------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null default '',
  email         text,
  phone         text,
  role          text not null default 'rep' check (role in ('admin', 'head', 'rep')),
  is_active     boolean not null default false,
  can_view_all  boolean not null default false,  -- торговый представитель видит всю базу (только чтение чужих)
  can_import    boolean not null default false,  -- разрешён импорт (не только администратору)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.profiles is 'Профили пользователей CRM. Пароли хранит Supabase Auth.';

create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();

-- Профиль создаётся автоматически при появлении пользователя в Supabase Auth.
-- Новый пользователь — всегда «торговый представитель» и неактивен, пока администратор
-- его не активирует. Метаданным регистрации (их задаёт сам пользователь) роль не доверяем.
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, is_active)
  values (new.id, new.email, left(coalesce(new.raw_user_meta_data->>'full_name', ''), 200), 'rep', false)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- Централизованные права. Все политики RLS опираются только на эти функции.
-- ---------------------------------------------------------------------------

create or replace function app.has_perm(perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case perm
      when 'active'              then true
      when 'view_all'            then p.role in ('admin', 'head') or p.can_view_all
      when 'edit_all'            then p.role in ('admin', 'head')
      when 'assign'              then p.role in ('admin', 'head')
      when 'view_team'           then p.role in ('admin', 'head')
      when 'archive'             then p.role in ('admin', 'head')
      when 'import'              then p.role = 'admin' or p.can_import
      when 'manage_users'        then p.role = 'admin'
      when 'manage_dictionaries' then p.role = 'admin'
      else false
    end
    from public.profiles p
    where p.id = auth.uid() and p.is_active
  ), false)
$$;

create or replace function app.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- Права текущего пользователя для интерфейса (кнопки скрываются, но проверка — в базе).
create or replace function public.my_permissions() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'role', app.my_role(),
    'active', app.has_perm('active'),
    'view_all', app.has_perm('view_all'),
    'edit_all', app.has_perm('edit_all'),
    'assign', app.has_perm('assign'),
    'view_team', app.has_perm('view_team'),
    'archive', app.has_perm('archive'),
    'import', app.has_perm('import'),
    'manage_users', app.has_perm('manage_users'),
    'manage_dictionaries', app.has_perm('manage_dictionaries')
  )
$$;

-- ---------------------------------------------------------------------------
-- Справочники
-- ---------------------------------------------------------------------------

create table public.directions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(btrim(name)) > 0),
  keywords   text[] not null default '{}',  -- слова для автоматического сопоставления категорий 2GIS при импорте
  sort       int not null default 100,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.services (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique check (length(btrim(name)) > 0),
  direction_id uuid references public.directions(id) on delete set null,
  sort         int not null default 100,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.equipment_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique check (length(btrim(name)) > 0),
  sort       int not null default 100,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.equipment_brands (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index equipment_brands_name_uq on public.equipment_brands (lower(btrim(name)));

create table public.client_statuses (
  code      text primary key,
  name      text not null,
  sort      int not null default 100,
  color     text not null default 'gray',
  is_active boolean not null default true
);

create table public.request_statuses (
  code      text primary key,
  name      text not null,
  sort      int not null default 100,
  is_final  boolean not null default false,
  color     text not null default 'gray',
  is_active boolean not null default true
);

create table public.deal_stages (
  code      text primary key,
  name      text not null,
  sort      int not null default 100,
  kind      text not null default 'open' check (kind in ('open', 'won', 'lost')),
  is_active boolean not null default true
);


-- ===== 20261022000200_clients.sql =====
-- Sillan CRM — 2. Клиентская база: компании (юрлица), точки, контакты, направления, услуги,
-- оборудование, фотографии, комментарии, история назначений.

create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  legal_name  text,
  bin         text check (bin is null or bin ~ '^\d{12}$'),
  client_type text,
  website     text,
  notes       text,
  name_norm   text generated always as (app.norm_text(name)) stored,
  created_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create unique index companies_bin_uq on public.companies (bin) where bin is not null;
create index companies_name_norm_idx on public.companies using gin (name_norm extensions.gin_trgm_ops);
create trigger companies_touch before update on public.companies
  for each row execute function app.touch_updated_at();

create table public.locations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid references public.companies(id) on delete set null,
  name                text not null check (length(btrim(name)) > 0),
  client_type         text,
  status_code         text not null default 'new' references public.client_statuses(code) on update cascade,
  country             text not null default 'Казахстан',
  city                text,
  district            text,
  source_address      text,             -- адрес из источника (2GIS); обновляется импортом
  confirmed_address   text,             -- адрес, подтверждённый менеджером; импорт его НЕ трогает
  address_note        text,
  lat                 double precision check (lat is null or lat between -90 and 90),
  lng                 double precision check (lng is null or lng between -180 and 180),
  phones              text[] not null default '{}',
  website             text,
  posts_count         int check (posts_count is null or posts_count >= 0),
  lifts_count         int check (lifts_count is null or lifts_count >= 0),
  infrastructure_note text,
  capacity_note       text,
  source              text not null default 'manual',
  source_url          text,
  external_id         text,
  source_category     text,
  last_import_at      timestamptz,
  last_import_job_id  uuid,
  manager_id          uuid references public.profiles(id) on delete set null,
  last_visit_at       timestamptz,      -- пересчитывается по визитам
  next_visit_date     date,             -- ближайший запланированный визит
  next_contact_date   date,             -- договорённость о следующем контакте
  search_text         text not null default '',
  phones_norm         text[] generated always as (app.norm_phones(phones)) stored,
  name_norm           text generated always as (app.norm_text(name)) stored,
  city_norm           text generated always as (app.norm_text(city)) stored,
  address_norm        text generated always as (app.norm_address(source_address)) stored,
  created_by          uuid references public.profiles(id) default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);
comment on column public.locations.confirmed_address is 'Подтверждённый менеджером фактический адрес. Импорт не перезаписывает.';

create unique index locations_source_ext_uq on public.locations (source, external_id) where external_id is not null;
create index locations_company_idx on public.locations (company_id);
create index locations_manager_idx on public.locations (manager_id);
create index locations_city_idx on public.locations (city, district);
create index locations_status_idx on public.locations (status_code);
create index locations_updated_idx on public.locations (updated_at desc);
create index locations_next_visit_idx on public.locations (next_visit_date);
create index locations_last_visit_idx on public.locations (last_visit_at);
create index locations_phones_idx on public.locations using gin (phones_norm);
create index locations_match_idx on public.locations (name_norm, city_norm);
create index locations_search_idx on public.locations using gin (search_text extensions.gin_trgm_ops);

create trigger locations_touch before update on public.locations
  for each row execute function app.touch_updated_at();

create table public.contacts (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations(id) on delete cascade,
  full_name         text,
  position          text,
  phone             text,
  whatsapp          text,
  email             text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  decision_role     text check (decision_role in ('decision_maker', 'influencer', 'user', 'other')),
  preferred_channel text check (preferred_channel in ('phone', 'whatsapp', 'telegram', 'email', 'visit')),
  comment           text,
  is_actual         boolean not null default true,
  is_primary        boolean not null default false,
  source            text not null default 'manual',
  phone_norm        text generated always as (app.norm_phone(phone)) stored,
  whatsapp_norm     text generated always as (app.norm_phone(whatsapp)) stored,
  created_by        uuid references public.profiles(id) default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  constraint contacts_something_known check (
    coalesce(nullif(btrim(full_name), ''), nullif(btrim(phone), ''), nullif(btrim(whatsapp), ''), nullif(btrim(email), '')) is not null
  )
);
create index contacts_location_idx on public.contacts (location_id);
create index contacts_phone_idx on public.contacts (phone_norm);
create trigger contacts_touch before update on public.contacts
  for each row execute function app.touch_updated_at();

create table public.location_directions (
  location_id  uuid not null references public.locations(id) on delete cascade,
  direction_id uuid not null references public.directions(id) on delete restrict,
  source       text not null default 'manual',
  created_by   uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  primary key (location_id, direction_id)
);
create index location_directions_dir_idx on public.location_directions (direction_id);

create table public.location_services (
  location_id uuid not null references public.locations(id) on delete cascade,
  service_id  uuid not null references public.services(id) on delete restrict,
  created_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  primary key (location_id, service_id)
);
create index location_services_srv_idx on public.location_services (service_id);

create table public.location_equipment (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  category_id uuid references public.equipment_categories(id) on delete set null,
  brand_id    uuid references public.equipment_brands(id) on delete set null,
  name        text not null check (length(btrim(name)) > 0),
  model       text,
  quantity    int not null default 1 check (quantity > 0),
  condition   text not null default 'unknown' check (condition in ('working', 'worn', 'needs_repair', 'broken', 'unknown')),
  need        text not null default 'none' check (need in ('none', 'replace', 'buy_more', 'upgrade', 'repair')),
  comment     text,
  created_by  uuid references public.profiles(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index location_equipment_loc_idx on public.location_equipment (location_id);
create index location_equipment_name_idx on public.location_equipment using gin (lower(name) extensions.gin_trgm_ops);
create trigger location_equipment_touch before update on public.location_equipment
  for each row execute function app.touch_updated_at();

create table public.location_photos (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.locations(id) on delete cascade,
  visit_id     uuid,
  storage_path text not null unique,
  caption      text,
  comment      text,
  mime_type    text,
  size_bytes   bigint,
  uploaded_by  uuid references public.profiles(id) default auth.uid(),
  created_at   timestamptz not null default now()
);
create index location_photos_loc_idx on public.location_photos (location_id, created_at desc);

create table public.comments (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations(id) on delete cascade,
  kind              text not null default 'comment'
                    check (kind in ('comment', 'expansion', 'purchase_plan', 'need', 'agreement', 'next_step')),
  body              text not null check (length(btrim(body)) > 0),
  next_contact_date date,
  author_id         uuid references public.profiles(id) default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz
);
create index comments_loc_idx on public.comments (location_id, created_at desc);
create trigger comments_touch before update on public.comments
  for each row execute function app.touch_updated_at();

-- История смены ответственного (записи не удаляются)
create table public.manager_assignments (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations(id) on delete cascade,
  from_manager_id uuid references public.profiles(id) on delete set null,
  to_manager_id   uuid references public.profiles(id) on delete set null,
  reason          text,
  assigned_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index manager_assignments_loc_idx on public.manager_assignments (location_id, created_at desc);

-- Правила назначения по территории (применяются только явно, кнопкой)
create table public.territory_rules (
  id         uuid primary key default gen_random_uuid(),
  city       text not null check (length(btrim(city)) > 0),
  district   text,
  manager_id uuid not null references public.profiles(id) on delete cascade,
  is_active  boolean not null default true,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index territory_rules_uq on public.territory_rules (lower(city), lower(coalesce(district, '')));

-- ---------------------------------------------------------------------------
-- Триггеры точек
-- ---------------------------------------------------------------------------

-- Поисковая строка: название, юрлицо, адреса, телефоны, контакты.
create or replace function app.location_search_text(l public.locations) returns text
language sql stable security definer set search_path = public as $$
  select lower(concat_ws(' ',
    l.name, l.city, l.district, l.source_address, l.confirmed_address,
    array_to_string(l.phones, ' '), array_to_string(l.phones_norm, ' '),
    (select concat_ws(' ', c.name, c.legal_name, c.bin) from public.companies c where c.id = l.company_id),
    (select string_agg(concat_ws(' ', ct.full_name, ct.phone, ct.phone_norm, ct.whatsapp_norm, ct.email), ' ')
       from public.contacts ct where ct.location_id = l.id and ct.archived_at is null)
  ))
$$;

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
       and auth.uid() is not null and not app.has_perm('assign') then
      raise exception 'Недостаточно прав для смены ответственного менеджера' using errcode = '42501';
    end if;
    if new.archived_at is distinct from old.archived_at
       and auth.uid() is not null and not app.has_perm('archive') then
      raise exception 'Недостаточно прав для архивирования клиента' using errcode = '42501';
    end if;
  end if;
  -- generated-колонки ещё не вычислены в BEFORE-триггере, поэтому телефоны нормализуем сами
  new.search_text := app.location_search_text(new) || ' ' || array_to_string(app.norm_phones(new.phones), ' ');
  return new;
end $$;

create trigger locations_before_write before insert or update on public.locations
  for each row execute function app.locations_before_write();

create or replace function app.locations_track_manager() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.manager_id is not null)
     or (tg_op = 'UPDATE' and new.manager_id is distinct from old.manager_id) then
    insert into public.manager_assignments (location_id, from_manager_id, to_manager_id, reason, assigned_by)
    values (new.id,
            case when tg_op = 'UPDATE' then old.manager_id end,
            new.manager_id,
            nullif(current_setting('app.assign_reason', true), ''),
            auth.uid());
  end if;
  return null;
end $$;

create trigger locations_track_manager after insert or update of manager_id on public.locations
  for each row execute function app.locations_track_manager();

-- Обновить поисковую строку точки (без изменения «даты последнего изменения»)
create or replace function app.refresh_location_search(p_location uuid) returns void
language plpgsql security definer set search_path = public as $$
declare prev text := coalesce(current_setting('app.system_update', true), '');
begin
  perform set_config('app.system_update', 'on', true);
  update public.locations set search_text = search_text where id = p_location;
  perform set_config('app.system_update', prev, true);
end $$;

create or replace function app.contacts_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform app.refresh_location_search(old.location_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.location_id <> old.location_id) then
    perform app.refresh_location_search(new.location_id);
  end if;
  -- только один основной контакт на точку
  if tg_op in ('INSERT', 'UPDATE') and new.is_primary then
    update public.contacts set is_primary = false
     where location_id = new.location_id and id <> new.id and is_primary;
  end if;
  return null;
end $$;

create trigger contacts_after_write after insert or update or delete on public.contacts
  for each row execute function app.contacts_after_write();

create or replace function app.companies_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.name, new.legal_name, new.bin) is distinct from (old.name, old.legal_name, old.bin) then
    perform set_config('app.system_update', 'on', true);
    update public.locations set search_text = search_text where company_id = new.id;
    perform set_config('app.system_update', '', true);
  end if;
  return null;
end $$;

create trigger companies_after_update after update on public.companies
  for each row execute function app.companies_after_update();


-- ===== 20261022000300_work_sales.sql =====
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


-- ===== 20261022000400_rls.sql =====
-- Sillan CRM — 4. Права доступа (Row Level Security).
-- Правила собраны в нескольких функциях app.*; политики ниже только ссылаются на них.
--   * Администратор и руководитель видят и редактируют всё.
--   * Торговый представитель видит и редактирует закреплённых за ним клиентов.
--     С флагом can_view_all — видит всю базу, но редактирует только своих.
--   * Неактивный пользователь не видит ничего.

create or replace function app.can_view_location(p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_perm('view_all')
      or exists (select 1 from public.locations l
                  where l.id = p_location and l.manager_id = auth.uid() and app.has_perm('active'))
$$;

create or replace function app.can_edit_location(p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.has_perm('edit_all')
      or exists (select 1 from public.locations l
                  where l.id = p_location and l.manager_id = auth.uid() and app.has_perm('active'))
$$;

create or replace function app.can_view_request(p_request uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.requests r
     where r.id = p_request
       and app.has_perm('active')
       and (r.initiator_id = auth.uid() or r.assignee_id = auth.uid()
            or app.has_perm('view_team') or app.can_view_location(r.location_id)))
$$;

grant execute on all functions in schema app to authenticated, service_role;

-- Анонимный доступ к данным CRM закрыт полностью.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'directions', 'services', 'equipment_categories', 'equipment_brands', 'client_statuses',
    'request_statuses', 'deal_stages', 'companies', 'locations', 'contacts', 'location_directions',
    'location_services', 'location_equipment', 'location_photos', 'comments', 'manager_assignments',
    'territory_rules', 'visit_plans', 'visits', 'requests', 'request_status_history', 'request_comments',
    'request_attachments', 'deals', 'notifications', 'import_jobs', 'import_rows', 'activity_logs']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Журналы ведутся только триггерами
revoke insert, update, delete on public.activity_logs, public.manager_assignments, public.request_status_history
  from authenticated;

-- ---------------------------------------------------------------------------
-- Профили
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using ((select app.has_perm('active')) or id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using ((select app.has_perm('manage_users')))
  with check ((select app.has_perm('manage_users')));

-- Администратор не может случайно снять права с самого себя / деактивировать себя
create or replace function app.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.id = auth.uid() and (new.role <> old.role or not new.is_active) then
    raise exception 'Нельзя менять собственную роль или деактивировать себя' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function app.profiles_guard();

-- ---------------------------------------------------------------------------
-- Справочники: читают все активные, меняет администратор.
-- Бренды оборудования может добавлять любой активный сотрудник (встречаются в поле).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['directions', 'services', 'equipment_categories', 'equipment_brands',
                           'client_statuses', 'request_statuses', 'deal_stages']
  loop
    execute format($f$create policy %1$s_select on public.%1$I for select to authenticated
                     using ((select app.has_perm('active')))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$I for insert to authenticated
                     with check ((select app.has_perm('manage_dictionaries')))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$I for update to authenticated
                     using ((select app.has_perm('manage_dictionaries')))
                     with check ((select app.has_perm('manage_dictionaries')))$f$, t);
  end loop;
end $$;
-- удалять справочники нельзя (только отключать is_active), чтобы не терять историю
revoke delete on public.directions, public.services, public.equipment_categories, public.equipment_brands,
  public.client_statuses, public.request_statuses, public.deal_stages from authenticated;

create policy equipment_brands_insert_any on public.equipment_brands for insert to authenticated
  with check ((select app.has_perm('active')));

-- ---------------------------------------------------------------------------
-- Компании
-- ---------------------------------------------------------------------------
create policy companies_select on public.companies for select to authenticated
  using ((select app.has_perm('view_all'))
         or ((select app.has_perm('active')) and created_by = auth.uid())
         or exists (select 1 from public.locations l
                     where l.company_id = companies.id and l.manager_id = auth.uid()));
create policy companies_insert on public.companies for insert to authenticated
  with check ((select app.has_perm('active')));
create policy companies_update on public.companies for update to authenticated
  using ((select app.has_perm('edit_all'))
         or ((select app.has_perm('active')) and created_by = auth.uid())
         or exists (select 1 from public.locations l
                     where l.company_id = companies.id and l.manager_id = auth.uid()))
  with check (true);
revoke delete on public.companies from authenticated;

-- ---------------------------------------------------------------------------
-- Точки
-- ---------------------------------------------------------------------------
create policy locations_select on public.locations for select to authenticated
  using ((select app.has_perm('view_all'))
         or (manager_id = auth.uid() and (select app.has_perm('active'))));
create policy locations_insert on public.locations for insert to authenticated
  with check ((select app.has_perm('active')));
create policy locations_update on public.locations for update to authenticated
  using ((select app.has_perm('edit_all'))
         or (manager_id = auth.uid() and (select app.has_perm('active'))))
  with check ((select app.has_perm('edit_all'))
              or (manager_id = auth.uid() and (select app.has_perm('active'))));
revoke delete on public.locations from authenticated;

-- ---------------------------------------------------------------------------
-- Данные точки: видно, если видна точка; менять — если можно редактировать точку.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['contacts', 'location_directions', 'location_services', 'location_equipment',
                           'location_photos', 'comments']
  loop
    execute format($f$create policy %1$s_select on public.%1$I for select to authenticated
                     using (app.can_view_location(location_id))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$I for insert to authenticated
                     with check (app.can_edit_location(location_id))$f$, t);
  end loop;
  foreach t in array array['contacts', 'location_equipment']
  loop
    execute format($f$create policy %1$s_update on public.%1$I for update to authenticated
                     using (app.can_edit_location(location_id))
                     with check (app.can_edit_location(location_id))$f$, t);
  end loop;
end $$;

-- Связи с направлениями/услугами можно снимать (это не история, а текущее состояние; изменения в журнале).
create policy location_directions_delete on public.location_directions for delete to authenticated
  using (app.can_edit_location(location_id));
create policy location_services_delete on public.location_services for delete to authenticated
  using (app.can_edit_location(location_id));

-- Комментарии редактирует автор (или руководство); удаление — только через архив.
create policy comments_update on public.comments for update to authenticated
  using ((author_id = auth.uid() and app.can_edit_location(location_id)) or (select app.has_perm('edit_all')))
  with check (app.can_view_location(location_id));

-- Фото удаляет автор загрузки или руководство.
create policy location_photos_update on public.location_photos for update to authenticated
  using (app.can_edit_location(location_id) and (uploaded_by = auth.uid() or (select app.has_perm('edit_all'))))
  with check (app.can_edit_location(location_id));
create policy location_photos_delete on public.location_photos for delete to authenticated
  using (app.can_edit_location(location_id) and (uploaded_by = auth.uid() or (select app.has_perm('edit_all'))));

revoke delete on public.contacts, public.location_equipment, public.comments from authenticated;

-- ---------------------------------------------------------------------------
-- Назначения и территории
-- ---------------------------------------------------------------------------
create policy manager_assignments_select on public.manager_assignments for select to authenticated
  using ((select app.has_perm('view_team')) or app.can_view_location(location_id));

create policy territory_rules_select on public.territory_rules for select to authenticated
  using ((select app.has_perm('active')));
create policy territory_rules_write on public.territory_rules for all to authenticated
  using ((select app.has_perm('assign'))) with check ((select app.has_perm('assign')));

-- ---------------------------------------------------------------------------
-- Планы и визиты
-- ---------------------------------------------------------------------------
create policy visit_plans_select on public.visit_plans for select to authenticated
  using ((manager_id = auth.uid() and (select app.has_perm('active'))) or (select app.has_perm('view_team')));
create policy visit_plans_insert on public.visit_plans for insert to authenticated
  with check ((manager_id = auth.uid() and (select app.has_perm('active'))) or (select app.has_perm('edit_all')));
create policy visit_plans_update on public.visit_plans for update to authenticated
  using ((manager_id = auth.uid() and (select app.has_perm('active'))) or (select app.has_perm('edit_all')))
  with check ((manager_id = auth.uid() and (select app.has_perm('active'))) or (select app.has_perm('edit_all')));
revoke delete on public.visit_plans from authenticated;

create policy visits_select on public.visits for select to authenticated
  using ((manager_id = auth.uid() and (select app.has_perm('active')))
         or (select app.has_perm('view_team'))
         or app.can_view_location(location_id));
create policy visits_insert on public.visits for insert to authenticated
  with check ((select app.has_perm('edit_all'))
              or (manager_id = auth.uid() and app.can_view_location(location_id)));
create policy visits_update on public.visits for update to authenticated
  using ((select app.has_perm('edit_all')) or (manager_id = auth.uid() and (select app.has_perm('active'))))
  with check ((select app.has_perm('edit_all')) or (manager_id = auth.uid() and (select app.has_perm('active'))));
-- из плана можно убрать только ещё не проведённый визит без результата
create policy visits_delete on public.visits for delete to authenticated
  using (status = 'planned' and result is null
         and ((select app.has_perm('edit_all')) or (manager_id = auth.uid() and (select app.has_perm('active')))));

-- ---------------------------------------------------------------------------
-- Заявки
-- ---------------------------------------------------------------------------
create policy requests_select on public.requests for select to authenticated
  using ((select app.has_perm('active'))
         and (initiator_id = auth.uid() or assignee_id = auth.uid()
              or (select app.has_perm('view_team')) or app.can_view_location(location_id)));
create policy requests_insert on public.requests for insert to authenticated
  with check ((select app.has_perm('active')) and app.can_view_location(location_id));
create policy requests_update on public.requests for update to authenticated
  using ((select app.has_perm('active'))
         and (initiator_id = auth.uid() or assignee_id = auth.uid() or (select app.has_perm('edit_all'))))
  with check (app.can_view_location(location_id) or assignee_id = auth.uid() or (select app.has_perm('edit_all')));
revoke delete on public.requests from authenticated;

create policy request_status_history_select on public.request_status_history for select to authenticated
  using (app.can_view_request(request_id));

create policy request_comments_select on public.request_comments for select to authenticated
  using (app.can_view_request(request_id));
create policy request_comments_insert on public.request_comments for insert to authenticated
  with check (app.can_view_request(request_id) and author_id = auth.uid());
revoke update, delete on public.request_comments from authenticated;

create policy request_attachments_select on public.request_attachments for select to authenticated
  using (app.can_view_request(request_id));
create policy request_attachments_insert on public.request_attachments for insert to authenticated
  with check (app.can_view_request(request_id));
create policy request_attachments_delete on public.request_attachments for delete to authenticated
  using (app.can_view_request(request_id) and (uploaded_by = auth.uid() or (select app.has_perm('edit_all'))));

-- ---------------------------------------------------------------------------
-- Сделки
-- ---------------------------------------------------------------------------
create policy deals_select on public.deals for select to authenticated
  using ((manager_id = auth.uid() and (select app.has_perm('active')))
         or (select app.has_perm('view_team')) or app.can_view_location(location_id));
create policy deals_insert on public.deals for insert to authenticated
  with check (app.can_view_location(location_id));
create policy deals_update on public.deals for update to authenticated
  using ((select app.has_perm('edit_all')) or (manager_id = auth.uid() and (select app.has_perm('active'))))
  with check ((select app.has_perm('edit_all')) or (manager_id = auth.uid() and (select app.has_perm('active'))));
revoke delete on public.deals from authenticated;

-- ---------------------------------------------------------------------------
-- Уведомления — только свои
-- ---------------------------------------------------------------------------
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_delete on public.notifications for delete to authenticated
  using (user_id = auth.uid());
revoke insert on public.notifications from authenticated;

-- ---------------------------------------------------------------------------
-- Импорт — только с правом import. Строки пишутся функцией импорта.
-- ---------------------------------------------------------------------------
create policy import_jobs_select on public.import_jobs for select to authenticated
  using ((select app.has_perm('import')) or (select app.has_perm('view_team')));
create policy import_jobs_insert on public.import_jobs for insert to authenticated
  with check ((select app.has_perm('import')));
create policy import_rows_select on public.import_rows for select to authenticated
  using ((select app.has_perm('import')) or (select app.has_perm('view_team')));
revoke update, delete on public.import_jobs from authenticated;
revoke insert, update, delete on public.import_rows from authenticated;

-- ---------------------------------------------------------------------------
-- Журнал действий
-- ---------------------------------------------------------------------------
create policy activity_logs_select on public.activity_logs for select to authenticated
  using ((select app.has_perm('view_team'))
         or actor_id = auth.uid()
         or (location_id is not null and app.can_view_location(location_id)));


-- ===== 20261022000500_rpc.sql =====
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


-- ===== 20261022000600_storage_seed.sql =====
-- Sillan CRM — 6. Хранилище файлов и начальные справочники.

-- ---------------------------------------------------------------------------
-- Supabase Storage: приватный бакет. Пути:
--   locations/<id точки>/<uuid>.<ext>   — фотографии точек
--   requests/<id заявки>/<uuid>.<ext>   — вложения заявок
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crm-files', 'crm-files', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel', 'application/msword', 'text/csv'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.can_access_file(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case (storage.foldername(p_name))[1]
    when 'locations' then
      case when p_write then app.can_edit_location(app.try_uuid((storage.foldername(p_name))[2]))
           else app.can_view_location(app.try_uuid((storage.foldername(p_name))[2])) end
    when 'requests' then app.can_view_request(app.try_uuid((storage.foldername(p_name))[2]))
    else false
  end
$$;
grant execute on function app.can_access_file(text, boolean) to authenticated;

create policy crm_files_select on storage.objects for select to authenticated
  using (bucket_id = 'crm-files' and app.can_access_file(name, false));
create policy crm_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'crm-files' and app.can_access_file(name, true));
create policy crm_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'crm-files' and app.can_access_file(name, true)
         and (owner = auth.uid() or app.has_perm('edit_all')));

-- ---------------------------------------------------------------------------
-- Справочники (редактируются в разделе «Настройки»)
-- ---------------------------------------------------------------------------
insert into public.directions (name, sort, keywords) values
  ('Автосервис / СТО', 10, array['автосервис', 'сто', 'ремонт авто', 'ремонт автомобил', 'автотехцентр', 'техцентр', 'слесар', 'ремонт двигател', 'ремонт подвес', 'ходов', 'развал']),
  ('Шиномонтаж и правка дисков', 20, array['шиномонтаж', 'шины', 'вулканизац', 'правка дисков', 'ремонт дисков', 'балансиров']),
  ('Пункт замены масла / ПЗМ', 30, array['замена масла', 'замена масел', 'пзм', 'масла', 'смазочн']),
  ('Промывка форсунок', 40, array['форсун', 'инжектор']),
  ('Кондиционеры / фреон', 50, array['кондиционер', 'фреон', 'автокондиционер', 'климат']),
  ('Проточка тормозных дисков', 60, array['проточка', 'тормозн']),
  ('Кузовной цех', 70, array['кузов', 'покраск', 'малярн', 'рихтовк', 'жестян']),
  ('Компьютерная диагностика', 80, array['диагностик', 'компьютерная диагностика', 'автоэлектрик', 'чип']),
  ('Автомойка (без самообслуживания)', 90, array['автомойк', 'мойка', 'детейлинг', 'химчистк'])
on conflict (name) do nothing;

insert into public.services (name, sort, direction_id)
select s.name, s.sort, (select id from public.directions d where d.name = s.dir)
from (values
  ('Ремонт подвески', 10, 'Автосервис / СТО'),
  ('Ремонт двигателя', 20, 'Автосервис / СТО'),
  ('Слесарные работы', 30, 'Автосервис / СТО'),
  ('Развал-схождение', 35, 'Автосервис / СТО'),
  ('Компьютерная диагностика', 40, 'Компьютерная диагностика'),
  ('Шиномонтаж', 50, 'Шиномонтаж и правка дисков'),
  ('Правка дисков', 60, 'Шиномонтаж и правка дисков'),
  ('Промывка форсунок', 70, 'Промывка форсунок'),
  ('Замена масла', 80, 'Пункт замены масла / ПЗМ'),
  ('Продажа запчастей', 90, null),
  ('Обслуживание кондиционеров', 100, 'Кондиционеры / фреон'),
  ('Проточка тормозных дисков', 110, 'Проточка тормозных дисков'),
  ('Кузовной ремонт', 120, 'Кузовной цех'),
  ('Покраска', 125, 'Кузовной цех'),
  ('Мойка', 130, 'Автомойка (без самообслуживания)')
) as s(name, sort, dir)
on conflict (name) do nothing;

insert into public.equipment_categories (name, sort) values
  ('Подъёмники', 10), ('Шиномонтажные станки', 20), ('Балансировочные станки', 30),
  ('Стенды развал-схождения', 40), ('Компрессоры', 50), ('Диагностическое оборудование', 60),
  ('Оборудование для замены масла', 70), ('Стенды промывки форсунок', 80),
  ('Установки заправки кондиционеров', 90), ('Станки проточки тормозных дисков', 100),
  ('Окрасочные камеры', 110), ('Моечное оборудование', 120), ('Гаражное оборудование и инструмент', 130),
  ('Прочее', 999)
on conflict (name) do nothing;

insert into public.client_statuses (code, name, sort, color) values
  ('new', 'Новый', 10, 'gray'),
  ('contacted', 'Установлен контакт', 20, 'blue'),
  ('in_work', 'В работе', 30, 'amber'),
  ('client', 'Клиент', 40, 'green'),
  ('not_interested', 'Не заинтересован', 50, 'rose'),
  ('closed', 'Не работает / закрыт', 60, 'slate')
on conflict (code) do nothing;

insert into public.request_statuses (code, name, sort, is_final, color) values
  ('new', 'Новая', 10, false, 'blue'),
  ('in_progress', 'Принята в работу', 20, false, 'amber'),
  ('clarification', 'Требуется уточнение', 30, false, 'orange'),
  ('offer_ready', 'Подготовлено предложение', 40, false, 'violet'),
  ('done', 'Выполнена', 50, true, 'green'),
  ('rejected', 'Отклонена', 60, true, 'rose'),
  ('cancelled', 'Отменена', 70, true, 'slate')
on conflict (code) do nothing;

insert into public.deal_stages (code, name, sort, kind) values
  ('need', 'Выявлена потребность', 10, 'open'),
  ('qualification', 'Квалификация', 20, 'open'),
  ('proposal_prep', 'Подготовка предложения', 30, 'open'),
  ('proposal_sent', 'Предложение отправлено', 40, 'open'),
  ('negotiation', 'Переговоры', 50, 'open'),
  ('won', 'Выиграна', 60, 'won'),
  ('lost', 'Проиграна', 70, 'lost')
on conflict (code) do nothing;


-- ===== 20261022000700_transactions.sql =====
-- Sillan CRM — 7. Связанные операции одной транзакцией.

alter table public.locations add column if not exists client_request_id uuid unique;

-- Создать точку вместе с компанией, направлениями, услугами, первым контактом и комментарием.
-- Права проверяются политиками RLS (security invoker). Повторная отправка возвращает уже созданную точку.
create or replace function public.create_location(p jsonb)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_company uuid := app.try_uuid(p->>'company_id');
  v_key uuid := app.try_uuid(p->>'client_request_id');
  c jsonb := p->'new_company';
  ct jsonb := p->'contact';
  x text;
begin
  if v_key is not null then
    select id into v_id from public.locations where client_request_id = v_key;
    if v_id is not null then return v_id; end if;
  end if;
  if nullif(btrim(p->>'name'), '') is null then
    raise exception 'Укажите название точки';
  end if;

  if v_company is null and c is not null and nullif(btrim(c->>'name'), '') is not null then
    insert into public.companies (name, legal_name, bin, client_type)
    values (btrim(c->>'name'), nullif(btrim(c->>'legal_name'), ''), nullif(btrim(c->>'bin'), ''), nullif(btrim(p->>'client_type'), ''))
    returning id into v_company;
  end if;

  insert into public.locations (company_id, name, client_type, status_code, city, district, confirmed_address, address_note,
                                phones, website, posts_count, lifts_count, infrastructure_note, source, manager_id, client_request_id)
  values (v_company, btrim(p->>'name'), nullif(btrim(p->>'client_type'), ''), coalesce(nullif(p->>'status_code', ''), 'new'),
          nullif(btrim(p->>'city'), ''), nullif(btrim(p->>'district'), ''), nullif(btrim(p->>'address'), ''),
          nullif(btrim(p->>'address_note'), ''),
          coalesce(array(select btrim(e) from jsonb_array_elements_text(coalesce(p->'phones', '[]')) e where btrim(e) <> ''), '{}'),
          nullif(btrim(p->>'website'), ''), nullif(p->>'posts_count', '')::int, nullif(p->>'lifts_count', '')::int,
          nullif(btrim(p->>'infrastructure_note'), ''), 'manual', app.try_uuid(p->>'manager_id'), v_key)
  returning id into v_id;

  for x in select jsonb_array_elements_text(coalesce(p->'direction_ids', '[]')) loop
    insert into public.location_directions (location_id, direction_id) values (v_id, x::uuid) on conflict do nothing;
  end loop;
  for x in select jsonb_array_elements_text(coalesce(p->'service_ids', '[]')) loop
    insert into public.location_services (location_id, service_id) values (v_id, x::uuid) on conflict do nothing;
  end loop;

  if ct is not null and coalesce(nullif(btrim(ct->>'full_name'), ''), nullif(btrim(ct->>'phone'), '')) is not null then
    insert into public.contacts (location_id, full_name, position, phone, whatsapp, decision_role, is_primary)
    values (v_id, nullif(btrim(ct->>'full_name'), ''), nullif(btrim(ct->>'position'), ''), nullif(btrim(ct->>'phone'), ''),
            nullif(btrim(ct->>'whatsapp'), ''), nullif(ct->>'decision_role', ''), true);
  end if;

  if nullif(btrim(p->>'comment'), '') is not null then
    insert into public.comments (location_id, body) values (v_id, btrim(p->>'comment'));
  end if;
  return v_id;
end $$;

-- Заменить набор направлений и услуг точки одной операцией
create or replace function public.set_location_links(p_location uuid, p_direction_ids uuid[], p_service_ids uuid[])
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not app.can_edit_location(p_location) then
    raise exception 'Недостаточно прав для изменения клиента' using errcode = '42501';
  end if;
  if p_direction_ids is not null then
    delete from public.location_directions where location_id = p_location and direction_id <> all(p_direction_ids);
    insert into public.location_directions (location_id, direction_id)
    select p_location, unnest(p_direction_ids) on conflict do nothing;
  end if;
  if p_service_ids is not null then
    delete from public.location_services where location_id = p_location and service_id <> all(p_service_ids);
    insert into public.location_services (location_id, service_id)
    select p_location, unnest(p_service_ids) on conflict do nothing;
  end if;
end $$;

revoke execute on function public.create_location(jsonb), public.set_location_links(uuid, uuid[], uuid[]) from anon;
grant execute on function public.create_location(jsonb), public.set_location_links(uuid, uuid[], uuid[]) to authenticated;

-- Комментарий с датой следующего контакта обновляет карточку клиента
create or replace function app.comments_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.next_contact_date is not null then
    update public.locations set next_contact_date = new.next_contact_date where id = new.location_id;
  end if;
  return null;
end $$;

create trigger comments_after_insert after insert on public.comments
  for each row execute function app.comments_after_insert();

-- Пользователь может изменить своё имя и телефон (роль и права меняет только администратор)
create or replace function public.update_my_profile(p_full_name text, p_phone text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Не выполнен вход' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'Укажите имя'; end if;
  update public.profiles set full_name = left(btrim(p_full_name), 200), phone = nullif(left(btrim(coalesce(p_phone, '')), 50), '')
   where id = auth.uid();
end $$;
revoke execute on function public.update_my_profile(text, text) from anon;
grant execute on function public.update_my_profile(text, text) to authenticated;

-- Руководитель или администратор открывает торговому представителю просмотр всей базы
create or replace function public.set_rep_view_all(p_user uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.has_perm('assign') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  update public.profiles set can_view_all = p_value where id = p_user and role = 'rep';
  if not found then raise exception 'Доступ ко всей базе настраивается только торговым представителям'; end if;
end $$;
revoke execute on function public.set_rep_view_all(uuid, boolean) from anon;
grant execute on function public.set_rep_view_all(uuid, boolean) to authenticated;

-- Функции доступны только вошедшим пользователям (по умолчанию PostgreSQL открывает их роли PUBLIC)
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;
alter default privileges in schema public revoke execute on functions from public, anon;

