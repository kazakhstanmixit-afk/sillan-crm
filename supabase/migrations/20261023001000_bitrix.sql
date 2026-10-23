-- Sillan CRM — 10. Отправка заявок в Битрикс24 (лид или сделка) через входящий вебхук.
-- Адрес вебхука хранится только в секретах Edge Function (BITRIX_WEBHOOK_URL), не в базе.

alter table public.requests add column if not exists bitrix_status text
  check (bitrix_status in ('pending', 'sent', 'error'));
alter table public.requests add column if not exists bitrix_entity text;
alter table public.requests add column if not exists bitrix_id text;
alter table public.requests add column if not exists bitrix_error text;
alter table public.requests add column if not exists bitrix_sent_at timestamptz;
create index if not exists requests_bitrix_idx on public.requests (bitrix_status) where bitrix_status is distinct from 'sent';

-- Настройки интеграций (без секретов). Читают активные пользователи, меняет администратор.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}',
  updated_by uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_select on public.app_settings;
drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_select on public.app_settings for select to authenticated using ((select app.has_perm('active')));
create policy app_settings_write on public.app_settings for all to authenticated
  using ((select app.has_perm('manage_users'))) with check ((select app.has_perm('manage_users')));
revoke all on public.app_settings from anon;
grant select, insert, update on public.app_settings to authenticated;

insert into public.app_settings (key, value) values ('bitrix', jsonb_build_object(
  'enabled', true,
  'entity', 'lead',                     -- lead | deal
  'source_name', 'Торговый представитель',
  'source_id', '',                      -- код источника в Битриксе; пусто — найти/создать по названию
  'kinds', jsonb_build_object(          -- по отделам: ответственный в Битриксе и воронка (для сделок)
    'service',   jsonb_build_object('assigned_by_id', '', 'category_id', ''),
    'parts',     jsonb_build_object('assigned_by_id', '', 'category_id', ''),
    'equipment', jsonb_build_object('assigned_by_id', '', 'category_id', ''))
)) on conflict (key) do nothing;

-- Статус отправки меняет только функция bitrix (service role); пользователи — нет
create or replace function app.requests_bitrix_guard() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null and (new.bitrix_status, new.bitrix_id, new.bitrix_error, new.bitrix_entity, new.bitrix_sent_at)
       is distinct from (old.bitrix_status, old.bitrix_id, old.bitrix_error, old.bitrix_entity, old.bitrix_sent_at) then
    new.bitrix_status := old.bitrix_status; new.bitrix_id := old.bitrix_id; new.bitrix_error := old.bitrix_error;
    new.bitrix_entity := old.bitrix_entity; new.bitrix_sent_at := old.bitrix_sent_at;
  end if;
  return new;
end $$;
drop trigger if exists requests_bitrix_guard on public.requests;
create trigger requests_bitrix_guard before update on public.requests
  for each row execute function app.requests_bitrix_guard();

create or replace function app.requests_bitrix_pending() returns trigger
language plpgsql as $$
begin
  if auth.uid() is not null or new.bitrix_status is null then
    new.bitrix_status := 'pending'; new.bitrix_id := null; new.bitrix_error := null; new.bitrix_entity := null; new.bitrix_sent_at := null;
  end if;
  return new;
end $$;
drop trigger if exists requests_bitrix_pending on public.requests;
create trigger requests_bitrix_pending before insert on public.requests
  for each row execute function app.requests_bitrix_pending();

revoke execute on function app.requests_bitrix_guard(), app.requests_bitrix_pending() from public, anon;
