-- Sillan CRM — 17. Исправление: функция отправки (service role) получает текст отчёта.
-- Внутри SECURITY DEFINER current_user — владелец функции, поэтому роль вызывающего
-- берём из настройки сессии (её ставит PostgREST/Supabase).

create or replace function app.is_service_call()
returns boolean language sql stable as $$
  select coalesce(current_setting('role', true), '') = 'service_role'
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
      or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
$$;
revoke execute on function app.is_service_call() from public, anon;

create or replace function public.daily_report_preview(p_date date default null)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not app.is_service_call() and not app.has_perm('view_team') then
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
