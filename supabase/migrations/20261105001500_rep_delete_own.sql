-- Sillan CRM — 15. Торговые удаляют и восстанавливают свои точки (закреплённые за ними).

-- удаление своих точек проходит только через delete_locations / restore_locations
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
       and auth.uid() is not null and not app.has_perm('archive')
       and coalesce(current_setting('app.own_archive', true), '') <> 'on' then
      raise exception 'Недостаточно прав для архивирования клиента' using errcode = '42501';
    end if;
  end if;
  -- generated-колонки ещё не вычислены в BEFORE-триггере, поэтому телефоны нормализуем сами
  new.search_text := app.location_search_text(new) || ' ' || array_to_string(app.norm_phones(new.phones), ' ');
  return new;
end $$;

create or replace function public.delete_locations(p_ids uuid[], p_reason text default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null or not app.has_perm('active') then
    raise exception 'Не выполнен вход' using errcode = '42501';
  end if;
  if not app.has_perm('archive') and exists (
       select 1 from public.locations where id = any(p_ids) and manager_id is distinct from auth.uid()) then
    raise exception 'Удалять можно только свои точки' using errcode = '42501';
  end if;
  delete from public.visits
   where location_id = any(p_ids) and status = 'planned' and result is null;
  perform set_config('app.own_archive', 'on', true);
  update public.locations set archived_at = now()
   where id = any(p_ids) and archived_at is null;
  get diagnostics n = row_count;
  perform set_config('app.own_archive', '', true);
  if nullif(btrim(p_reason), '') is not null then
    insert into public.comments (location_id, body)
    select id, 'Точка удалена: ' || btrim(p_reason) from public.locations where id = any(p_ids);
  end if;
  return n;
end $$;

create or replace function public.restore_locations(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null or not app.has_perm('active') then
    raise exception 'Не выполнен вход' using errcode = '42501';
  end if;
  if not app.has_perm('archive') and exists (
       select 1 from public.locations where id = any(p_ids) and manager_id is distinct from auth.uid()) then
    raise exception 'Восстанавливать можно только свои точки' using errcode = '42501';
  end if;
  perform set_config('app.own_archive', 'on', true);
  update public.locations set archived_at = null where id = any(p_ids) and archived_at is not null;
  get diagnostics n = row_count;
  perform set_config('app.own_archive', '', true);
  return n;
end $$;
revoke execute on function public.delete_locations(uuid[], text), public.restore_locations(uuid[]) from public, anon;
grant execute on function public.delete_locations(uuid[], text), public.restore_locations(uuid[]) to authenticated;
revoke execute on function app.locations_before_write() from public, anon;
