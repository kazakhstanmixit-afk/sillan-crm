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
