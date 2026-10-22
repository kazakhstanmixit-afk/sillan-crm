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
