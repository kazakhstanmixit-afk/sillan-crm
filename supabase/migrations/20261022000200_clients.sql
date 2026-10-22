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
