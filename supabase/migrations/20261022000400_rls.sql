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
