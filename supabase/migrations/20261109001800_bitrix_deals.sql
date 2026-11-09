-- Sillan CRM — 18. Заявки → сделки Битрикс24 в воронках отделов.
-- Заявки одного клиента в один отдел за один день собираются в одну сделку.
-- Адрес вебхука хранится только в секретах Edge Function (BITRIX_WEBHOOK_URL или BITRIX_REPORT_WEBHOOK).

-- ---------------------------------------------------------------------------
-- Сделка Битрикс24 = клиент + отдел + день
-- ---------------------------------------------------------------------------
create table if not exists public.bitrix_deals (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null references public.locations(id) on delete cascade,
  kind              text not null check (kind in ('service', 'parts', 'equipment')),
  deal_day          date not null,
  status            text not null default 'pending' check (status in ('pending', 'sent', 'error')),
  bitrix_deal_id    text,
  bitrix_company_id text,
  bitrix_contact_id text,
  bitrix_assigned_id text,
  error             text,
  attempts          int not null default 0,
  locked_until      timestamptz,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (location_id, kind, deal_day)
);
create index if not exists bitrix_deals_pending_idx on public.bitrix_deals (status) where status <> 'sent';
alter table public.bitrix_deals enable row level security;
drop policy if exists bitrix_deals_select on public.bitrix_deals;
create policy bitrix_deals_select on public.bitrix_deals for select to authenticated
  using ((select app.has_perm('active')) and ((select app.has_perm('view_team')) or app.can_view_location(location_id)));
revoke all on public.bitrix_deals from anon, authenticated;
grant select on public.bitrix_deals to authenticated;

alter table public.requests add column if not exists bitrix_deal_ref uuid references public.bitrix_deals(id) on delete set null;
alter table public.requests add column if not exists bitrix_synced_at timestamptz;
create index if not exists requests_bitrix_deal_idx on public.requests (bitrix_deal_ref);

-- Новая заявка: найти/создать сделку дня и пометить её к отправке
create or replace function app.requests_bitrix_link() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_deal uuid;
begin
  if tg_op = 'UPDATE' and new.location_id is not distinct from old.location_id and new.kind is not distinct from old.kind
     and new.bitrix_deal_ref is not distinct from old.bitrix_deal_ref then
    return new;
  end if;
  insert into public.bitrix_deals (location_id, kind, deal_day)
  values (new.location_id, new.kind, app.local_date(coalesce(new.created_at, now())))
  on conflict (location_id, kind, deal_day) do update set status = 'pending', updated_at = clock_timestamp()
  returning id into v_deal;
  update public.bitrix_deals set status = 'pending', updated_at = clock_timestamp() where id = v_deal;
  new.bitrix_deal_ref := v_deal;
  new.bitrix_synced_at := null;
  return new;
end $$;
drop trigger if exists requests_bitrix_link on public.requests;
create trigger requests_bitrix_link before insert or update of location_id, kind on public.requests
  for each row execute function app.requests_bitrix_link();

-- Служебные поля Битрикса меняет только функция отправки (service role)
create or replace function app.requests_bitrix_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and auth.uid() is not null
     and new.bitrix_synced_at is distinct from old.bitrix_synced_at
     and new.location_id is not distinct from old.location_id and new.kind is not distinct from old.kind then
    new.bitrix_synced_at := old.bitrix_synced_at;
  end if;
  return new;
end $$;
drop trigger if exists requests_bitrix_guard on public.requests;
create trigger requests_bitrix_guard before update on public.requests
  for each row execute function app.requests_bitrix_guard();

-- Уже созданные заявки: собрать в сделки (отправятся кнопкой «Отправить неотправленные»)
do $$
declare r record;
begin
  for r in select id, location_id, kind, created_at from public.requests where bitrix_deal_ref is null loop
    insert into public.bitrix_deals (location_id, kind, deal_day)
    values (r.location_id, r.kind, app.local_date(r.created_at))
    on conflict (location_id, kind, deal_day) do nothing;
    update public.requests q set bitrix_deal_ref = d.id
      from public.bitrix_deals d
     where q.id = r.id and d.location_id = r.location_id and d.kind = r.kind and d.deal_day = app.local_date(r.created_at);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Настройки (без секретов): воронки, ответственные, поля формы сделки
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values ('bitrix_deals', jsonb_build_object(
  'enabled', false,
  'create_company', true,
  'crm_url', '',
  'kinds', jsonb_build_object(
    'service',   jsonb_build_object('category_id', '', 'assigned_ids', ''),
    'parts',     jsonb_build_object('category_id', '', 'assigned_ids', ''),
    'equipment', jsonb_build_object('category_id', '', 'assigned_ids', '')),  -- ID менеджеров через запятую: по очереди
  -- поля формы сделки: код поля Битрикса (UF_CRM_…) и, для списков, ID значения
  'fields', jsonb_build_object('source', '', 'source_value', '', 'city', '', 'need', '', 'count', '', 'whatsapp', '')
)) on conflict (key) do nothing;

-- Сводка для настроек и карточки заявки
create or replace function public.bitrix_deals_stats()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pending', count(*) filter (where status = 'pending'),
    'error',   count(*) filter (where status = 'error'),
    'sent',    count(*) filter (where status = 'sent'),
    'last_error', (select error from public.bitrix_deals where status = 'error' order by updated_at desc limit 1))
  from public.bitrix_deals
  where app.has_perm('view_team')
$$;
revoke execute on function public.bitrix_deals_stats() from public, anon;
grant execute on function public.bitrix_deals_stats() to authenticated;

-- Автоотправка: раз в 10 минут функция bitrix досылает всё, что не ушло (pg_cron + pg_net)
create or replace function public.setup_bitrix_sync(p_function_url text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_token text;
begin
  if not app.has_perm('manage_users') then
    raise exception 'Настраивает администратор' using errcode = '42501';
  end if;
  if p_function_url !~ '^https?://[^\s''"]+/functions/v1/bitrix$' then
    raise exception 'Неверный адрес функции';
  end if;
  select value into v_token from app.report_secrets where key = 'cron_token';
  if v_token is null then
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into app.report_secrets (key, value) values ('cron_token', v_token);
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    if p_enabled then
      raise exception 'В Supabase не включены расширения pg_cron и pg_net: Database → Extensions → включите оба и повторите';
    end if;
    return jsonb_build_object('scheduled', false);
  end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'sillan-bitrix-sync';
  if p_enabled then
    perform cron.schedule('sillan-bitrix-sync', '*/10 * * * *', format(
      'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 60000)',
      p_function_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-report-token', v_token)::text,
      '{"action":"sync_pending"}'));
  end if;
  return jsonb_build_object('scheduled', p_enabled);
end $$;
revoke execute on function public.setup_bitrix_sync(text, boolean) from public, anon;
grant execute on function public.setup_bitrix_sync(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Для функции отправки (только service role)
-- ---------------------------------------------------------------------------
-- Взять сделку в работу на 2 минуты (чтобы одновременная отправка не создала дубль в Битриксе)
create or replace function public.bitrix_claim_deal(p_id uuid)
returns timestamptz language sql security definer set search_path = public as $$
  update public.bitrix_deals
     set locked_until = now() + interval '2 minutes', attempts = attempts + 1, updated_at = clock_timestamp()
   where id = p_id and (locked_until is null or locked_until < now())
  returning updated_at
$$;

-- Всё для сделки одним JSON: точка, компания, контакты, заявки, кто создал, прошлые ID в Битриксе
create or replace function public.bitrix_deal_payload(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'deal_day', d.deal_day, 'bitrix_deal_id', d.bitrix_deal_id,
    'bitrix_company_id', coalesce(d.bitrix_company_id,
       (select x.bitrix_company_id from public.bitrix_deals x where x.location_id = d.location_id and x.bitrix_company_id is not null limit 1)),
    'bitrix_contact_id', coalesce(d.bitrix_contact_id,
       (select x.bitrix_contact_id from public.bitrix_deals x where x.location_id = d.location_id and x.bitrix_contact_id is not null limit 1)),
    'bitrix_assigned_id', d.bitrix_assigned_id,
    -- тот же клиент в том же отделе — тому же менеджеру; иначе по очереди
    'prev_assigned_id', (select x.bitrix_assigned_id from public.bitrix_deals x
        where x.location_id = d.location_id and x.kind = d.kind and x.bitrix_assigned_id is not null and x.id <> d.id
        order by x.deal_day desc limit 1),
    'kind_created', (select count(*) from public.bitrix_deals x where x.kind = d.kind and x.bitrix_deal_id is not null),
    'location', jsonb_build_object('id', l.id, 'name', l.name, 'city', l.city,
       'address', coalesce(nullif(l.confirmed_address, ''), l.source_address), 'phones', to_jsonb(l.phones),
       'legal_name', c.legal_name, 'bin', c.bin),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('full_name', k.full_name, 'position', k.position, 'phone', k.phone,
         'whatsapp', k.whatsapp, 'email', k.email, 'decision_maker', k.decision_role = 'decision_maker')
         order by (k.decision_role = 'decision_maker') desc, k.is_primary desc, k.created_at)
       from public.contacts k where k.location_id = l.id and k.archived_at is null and k.is_actual), '[]'),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'number', q.number, 'item_name', q.item_name,
         'brand', q.brand, 'model', q.model, 'article', q.article, 'quantity', q.quantity, 'budget', q.budget,
         'urgency', q.urgency, 'description', q.description, 'comment', q.comment,
         'category', (select e.name from public.equipment_categories e where e.id = q.category_id),
         'initiator', (select p.full_name from public.profiles p where p.id = q.initiator_id)) order by q.created_at)
       from public.requests q where q.bitrix_deal_ref = d.id), '[]'))
  from public.bitrix_deals d
  join public.locations l on l.id = d.location_id
  left join public.companies c on c.id = l.company_id
  where d.id = p_id
$$;

-- Итог отправки. Если пока отправляли, пришла новая заявка — сделка остаётся к отправке.
create or replace function public.bitrix_finish_deal(p_id uuid, p_claimed timestamptz, p_ok boolean, p_error text,
  p_deal_id text, p_company_id text, p_contact_id text, p_request_ids uuid[], p_assigned_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bitrix_deals
     set status = case when not p_ok then 'error' when updated_at > p_claimed then 'pending' else 'sent' end,
         error = case when p_ok then null else left(p_error, 1000) end,
         bitrix_deal_id = coalesce(p_deal_id, bitrix_deal_id),
         bitrix_company_id = coalesce(p_company_id, bitrix_company_id),
         bitrix_contact_id = coalesce(p_contact_id, bitrix_contact_id),
         bitrix_assigned_id = coalesce(p_assigned_id, bitrix_assigned_id),
         sent_at = case when p_ok then now() else sent_at end,
         attempts = case when p_ok then 0 else attempts end,
         locked_until = null
   where id = p_id;
  if p_ok then
    update public.requests set bitrix_synced_at = now() where id = any(p_request_ids) and bitrix_deal_ref = p_id;
  end if;
end $$;

-- Какие сделки отправлять: по заявкам или все неотправленные
create or replace function public.bitrix_deals_to_sync(p_request_ids uuid[] default null, p_limit int default 25)
returns setof uuid language sql stable security definer set search_path = public as $$
  select d.id from public.bitrix_deals d
   where (p_request_ids is null and d.status <> 'sent' and d.attempts < 20)
      or (p_request_ids is not null and d.id in (select q.bitrix_deal_ref from public.requests q where q.id = any(p_request_ids)))
   order by d.deal_day, d.created_at
   limit greatest(1, least(p_limit, 100))
$$;

revoke execute on function public.bitrix_claim_deal(uuid), public.bitrix_deal_payload(uuid),
  public.bitrix_finish_deal(uuid, timestamptz, boolean, text, text, text, text, uuid[], text),
  public.bitrix_deals_to_sync(uuid[], int) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bitrix_claim_deal(uuid), public.bitrix_deal_payload(uuid),
      public.bitrix_finish_deal(uuid, timestamptz, boolean, text, text, text, text, uuid[], text),
      public.bitrix_deals_to_sync(uuid[], int) to service_role';
  end if;
end $$;

revoke execute on function app.requests_bitrix_link(), app.requests_bitrix_guard() from public, anon;
