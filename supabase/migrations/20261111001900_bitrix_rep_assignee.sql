-- Sillan CRM — 19. Ответственный по сделке — торговый, создавший заявку (его ID в Битрикс24).

alter table public.profiles add column if not exists bitrix_user_id text check (bitrix_user_id ~ '^\d+$');

create or replace function public.set_profile_bitrix_id(p_user uuid, p_bitrix_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not app.has_perm('manage_users') then
    raise exception 'Настраивает администратор' using errcode = '42501';
  end if;
  if nullif(btrim(p_bitrix_id), '') is not null and btrim(p_bitrix_id) !~ '^\d+$' then
    raise exception 'ID в Битрикс24 — число из адреса профиля';
  end if;
  update public.profiles set bitrix_user_id = nullif(btrim(p_bitrix_id), '') where id = p_user;
end $$;
revoke execute on function public.set_profile_bitrix_id(uuid, text) from public, anon;
grant execute on function public.set_profile_bitrix_id(uuid, text) to authenticated;

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
    -- ID в Битриксе торгового, создавшего первую заявку (или ответственного за точку)
    'rep_bitrix_id', coalesce(
       (select p.bitrix_user_id from public.requests q join public.profiles p on p.id = q.initiator_id
         where q.bitrix_deal_ref = d.id and p.bitrix_user_id is not null order by q.created_at limit 1),
       (select p.bitrix_user_id from public.profiles p where p.id = l.manager_id)),
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
revoke execute on function public.bitrix_deal_payload(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bitrix_deal_payload(uuid) to service_role';
  end if;
end $$;

-- сделки, на которых Битрикс отвечал ошибкой, — снова к отправке (повтор найдёт уже созданную, а не создаст новую)
update public.bitrix_deals set attempts = 0 where status = 'error';
