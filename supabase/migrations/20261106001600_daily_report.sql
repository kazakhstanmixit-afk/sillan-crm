-- Sillan CRM — 16. Ежедневный отчёт торговых в личку Битрикс24 (в 19:00 по Астане).
-- Текст отчёта собирается здесь; отправляет Edge Function daily-report через входящий
-- вебхук Битрикс24 (секрет BITRIX_REPORT_WEBHOOK хранится только в Supabase Secrets).

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

insert into public.app_settings (key, value) values
  ('daily_report', jsonb_build_object('enabled', false, 'recipient_id', '', 'crm_url', ''))
on conflict (key) do nothing;

-- Секреты расписания (не видны через API)
create table if not exists app.report_secrets (
  key   text primary key,
  value text not null
);
revoke all on app.report_secrets from public, anon, authenticated;

-- Местная дата (Астана, UTC+5)
create or replace function app.local_date(p_ts timestamptz)
returns date language sql immutable as $$ select (p_ts at time zone 'Etc/GMT-5')::date $$;

create or replace function app.fmt_money(p numeric)
returns text language sql immutable as $$
  select replace(to_char(round(p), 'FM999G999G999G990'), ',', ' ') || ' ₸'
$$;

-- ---------------------------------------------------------------------------
-- Цифры за день по каждому торговому
-- ---------------------------------------------------------------------------
create or replace function app.daily_report_rows(p_date date)
returns table (
  manager_id uuid, full_name text,
  planned int, done int, failed int, found_pts int,
  i_high int, i_medium int, i_low int, i_none int,
  r_service int, r_parts int, r_equipment int, r_sum numeric
) language sql stable as $$
  with v as (
    select v.manager_id,
           count(*) filter (where v.planned_date = p_date and v.status in ('planned', 'done', 'failed')) planned,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date) done,
           count(*) filter (where v.planned_date = p_date and v.status = 'failed') failed,
           count(*) filter (where v.planned_date = p_date and v.purpose = 'Новая точка по пути') found_pts,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'high') i_high,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'medium') i_medium,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'low') i_low,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'none') i_none
      from public.visits v
     where v.planned_date between p_date - 31 and p_date + 1
     group by v.manager_id
  ), r as (
    select q.initiator_id manager_id,
           count(*) filter (where q.kind = 'service') r_service,
           count(*) filter (where q.kind = 'parts') r_parts,
           count(*) filter (where q.kind = 'equipment') r_equipment,
           coalesce(sum(q.budget), 0) r_sum
      from public.requests q
     where app.local_date(q.created_at) = p_date
     group by q.initiator_id
  )
  select p.id, p.full_name,
         coalesce(v.planned, 0)::int, coalesce(v.done, 0)::int, coalesce(v.failed, 0)::int, coalesce(v.found_pts, 0)::int,
         coalesce(v.i_high, 0)::int, coalesce(v.i_medium, 0)::int, coalesce(v.i_low, 0)::int, coalesce(v.i_none, 0)::int,
         coalesce(r.r_service, 0)::int, coalesce(r.r_parts, 0)::int, coalesce(r.r_equipment, 0)::int, coalesce(r.r_sum, 0)
    from public.profiles p
    left join v on v.manager_id = p.id
    left join r on r.manager_id = p.id
   where p.role = 'rep' and p.is_active
     and (p.in_autoplan or coalesce(v.planned, 0) + coalesce(v.done, 0) + coalesce(r.r_service + r.r_parts + r.r_equipment, 0) > 0)
   order by p.full_name
$$;

-- ---------------------------------------------------------------------------
-- Текст отчёта (BB-коды Битрикс24). null — день без работы, отправлять нечего.
-- ---------------------------------------------------------------------------
create or replace function app.daily_report_text(p_date date)
returns text language plpgsql stable as $$
declare
  x record;
  t record;
  days text[] := array['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  msg text;
  url text := nullif(btrim((select value->>'crm_url' from public.app_settings where key = 'daily_report')), '');
  reqs text;
begin
  select coalesce(sum(planned), 0) planned, coalesce(sum(done), 0) done, coalesce(sum(failed), 0) failed,
         coalesce(sum(found_pts), 0) found_pts, coalesce(sum(i_high), 0) i_high, coalesce(sum(i_medium), 0) i_medium,
         coalesce(sum(i_low), 0) i_low, coalesce(sum(i_none), 0) i_none,
         coalesce(sum(r_service), 0) r_service, coalesce(sum(r_parts), 0) r_parts,
         coalesce(sum(r_equipment), 0) r_equipment, coalesce(sum(r_sum), 0) r_sum
    into t from app.daily_report_rows(p_date);
  if t.planned + t.done + t.r_service + t.r_parts + t.r_equipment = 0 then
    return null;
  end if;

  msg := '[B]Отчёт торговых представителей — ' || to_char(p_date, 'DD.MM.YYYY') || ', '
         || days[extract(isodow from p_date)::int] || '[/B]';

  for x in select * from app.daily_report_rows(p_date) loop
    reqs := case when x.r_service + x.r_parts + x.r_equipment = 0 then 'нет'
                 else 'сервис ' || x.r_service || ', запчасти ' || x.r_parts || ', покупка оборудования ' || x.r_equipment
                      || case when x.r_sum > 0 then ' — на ' || app.fmt_money(x.r_sum) else '' end end;
    msg := msg || E'\n\n[B]' || x.full_name || '[/B]'
      || E'\nТочки: посещено ' || x.done || ' из ' || x.planned
      || case when x.failed > 0 then ', не состоялось ' || x.failed else '' end
      || case when x.planned > x.done + x.failed then ', не отмечено ' || (x.planned - x.done - x.failed) else '' end
      || case when x.found_pts > 0 then E'\nНовые точки по пути: ' || x.found_pts else '' end
      || E'\nИнтерес: высокий ' || x.i_high || ', средний ' || x.i_medium || ', низкий ' || x.i_low || ', нет ' || x.i_none
      || E'\nЗаявки: ' || reqs;
  end loop;

  msg := msg || E'\n\n[B]Итого[/B]: посещено ' || t.done || ' из ' || t.planned
    || E'\nИнтерес высокий/средний: ' || (t.i_high + t.i_medium)
    || E'\nЗаявок: ' || (t.r_service + t.r_parts + t.r_equipment)
    || ' (сервис ' || t.r_service || ', запчасти ' || t.r_parts || ', покупка оборудования ' || t.r_equipment || ')'
    || case when t.r_sum > 0 then ' — на ' || app.fmt_money(t.r_sum) else '' end
    || case when url is not null then E'\n\nПодробно в CRM: ' || rtrim(url, '/') || '/team' else '' end;
  return msg;
end $$;

-- Предпросмотр в CRM (руководитель/администратор) и текст для функции отправки (service role)
create or replace function public.daily_report_preview(p_date date default null)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if current_user <> 'service_role' and not app.has_perm('view_team') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  return app.daily_report_text(coalesce(p_date, app.local_date(now())));
end $$;
revoke execute on function public.daily_report_preview(date) from public, anon;
grant execute on function public.daily_report_preview(date) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.daily_report_preview(date) to service_role';
  end if;
end $$;

-- Проверка токена расписания (только для функции отправки)
create or replace function public.daily_report_check_token(p_token text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app.report_secrets where key = 'cron_token' and value = p_token and length(p_token) >= 32)
$$;
revoke execute on function public.daily_report_check_token(text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.daily_report_check_token(text) to service_role';
  end if;
end $$;

-- pg_net — для вызова функции из расписания (на Supabase доступно)
do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net недоступно: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Включить/выключить ежедневную отправку (вызывает администратор из настроек CRM)
-- ---------------------------------------------------------------------------
create or replace function public.setup_daily_report(p_function_url text, p_enabled boolean, p_recipient_id text, p_crm_url text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_token text;
  v_cmd text;
begin
  if not app.has_perm('manage_users') then
    raise exception 'Настраивает администратор' using errcode = '42501';
  end if;
  if p_enabled and coalesce(btrim(p_recipient_id), '') !~ '^\d+$' then
    raise exception 'Укажите ID получателя в Битрикс24 (число)';
  end if;
  if p_function_url !~ '^https?://[^\s''"]+/functions/v1/daily-report$' then
    raise exception 'Неверный адрес функции';
  end if;

  insert into public.app_settings (key, value) values ('daily_report', '{}')
  on conflict (key) do nothing;
  update public.app_settings
     set value = value || jsonb_build_object('enabled', p_enabled, 'recipient_id', btrim(coalesce(p_recipient_id, '')),
                                             'crm_url', btrim(coalesce(p_crm_url, ''))),
         updated_by = auth.uid(), updated_at = now()
   where key = 'daily_report';

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

  perform cron.unschedule(jobid) from cron.job where jobname = 'sillan-daily-report';
  if p_enabled then
    v_cmd := format(
      'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 30000)',
      p_function_url,
      jsonb_build_object('Content-Type', 'application/json', 'x-report-token', v_token)::text,
      '{"source":"cron"}');
    -- 19:00 по Астане = 14:00 UTC, каждый день (в день без работы отчёт не отправляется)
    perform cron.schedule('sillan-daily-report', '0 14 * * *', v_cmd);
  end if;
  return jsonb_build_object('scheduled', p_enabled);
end $$;
revoke execute on function public.setup_daily_report(text, boolean, text, text) from public, anon;
grant execute on function public.setup_daily_report(text, boolean, text, text) to authenticated;

revoke execute on function app.local_date(timestamptz), app.fmt_money(numeric), app.daily_report_rows(date),
  app.daily_report_text(date) from public, anon;
