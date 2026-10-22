-- Sillan CRM — 6. Хранилище файлов и начальные справочники.

-- ---------------------------------------------------------------------------
-- Supabase Storage: приватный бакет. Пути:
--   locations/<id точки>/<uuid>.<ext>   — фотографии точек
--   requests/<id заявки>/<uuid>.<ext>   — вложения заявок
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crm-files', 'crm-files', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel', 'application/msword', 'text/csv'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.can_access_file(p_name text, p_write boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select case (storage.foldername(p_name))[1]
    when 'locations' then
      case when p_write then app.can_edit_location(app.try_uuid((storage.foldername(p_name))[2]))
           else app.can_view_location(app.try_uuid((storage.foldername(p_name))[2])) end
    when 'requests' then app.can_view_request(app.try_uuid((storage.foldername(p_name))[2]))
    else false
  end
$$;
grant execute on function app.can_access_file(text, boolean) to authenticated;

create policy crm_files_select on storage.objects for select to authenticated
  using (bucket_id = 'crm-files' and app.can_access_file(name, false));
create policy crm_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'crm-files' and app.can_access_file(name, true));
create policy crm_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'crm-files' and app.can_access_file(name, true)
         and (owner = auth.uid() or app.has_perm('edit_all')));

-- ---------------------------------------------------------------------------
-- Справочники (редактируются в разделе «Настройки»)
-- ---------------------------------------------------------------------------
insert into public.directions (name, sort, keywords) values
  ('Автосервис / СТО', 10, array['автосервис', 'сто', 'ремонт авто', 'ремонт автомобил', 'автотехцентр', 'техцентр', 'слесар', 'ремонт двигател', 'ремонт подвес', 'ходов', 'развал']),
  ('Шиномонтаж и правка дисков', 20, array['шиномонтаж', 'шины', 'вулканизац', 'правка дисков', 'ремонт дисков', 'балансиров']),
  ('Пункт замены масла / ПЗМ', 30, array['замена масла', 'замена масел', 'пзм', 'масла', 'смазочн']),
  ('Промывка форсунок', 40, array['форсун', 'инжектор']),
  ('Кондиционеры / фреон', 50, array['кондиционер', 'фреон', 'автокондиционер', 'климат']),
  ('Проточка тормозных дисков', 60, array['проточка', 'тормозн']),
  ('Кузовной цех', 70, array['кузов', 'покраск', 'малярн', 'рихтовк', 'жестян']),
  ('Компьютерная диагностика', 80, array['диагностик', 'компьютерная диагностика', 'автоэлектрик', 'чип']),
  ('Автомойка (без самообслуживания)', 90, array['автомойк', 'мойка', 'детейлинг', 'химчистк'])
on conflict (name) do nothing;

insert into public.services (name, sort, direction_id)
select s.name, s.sort, (select id from public.directions d where d.name = s.dir)
from (values
  ('Ремонт подвески', 10, 'Автосервис / СТО'),
  ('Ремонт двигателя', 20, 'Автосервис / СТО'),
  ('Слесарные работы', 30, 'Автосервис / СТО'),
  ('Развал-схождение', 35, 'Автосервис / СТО'),
  ('Компьютерная диагностика', 40, 'Компьютерная диагностика'),
  ('Шиномонтаж', 50, 'Шиномонтаж и правка дисков'),
  ('Правка дисков', 60, 'Шиномонтаж и правка дисков'),
  ('Промывка форсунок', 70, 'Промывка форсунок'),
  ('Замена масла', 80, 'Пункт замены масла / ПЗМ'),
  ('Продажа запчастей', 90, null),
  ('Обслуживание кондиционеров', 100, 'Кондиционеры / фреон'),
  ('Проточка тормозных дисков', 110, 'Проточка тормозных дисков'),
  ('Кузовной ремонт', 120, 'Кузовной цех'),
  ('Покраска', 125, 'Кузовной цех'),
  ('Мойка', 130, 'Автомойка (без самообслуживания)')
) as s(name, sort, dir)
on conflict (name) do nothing;

insert into public.equipment_categories (name, sort) values
  ('Подъёмники', 10), ('Шиномонтажные станки', 20), ('Балансировочные станки', 30),
  ('Стенды развал-схождения', 40), ('Компрессоры', 50), ('Диагностическое оборудование', 60),
  ('Оборудование для замены масла', 70), ('Стенды промывки форсунок', 80),
  ('Установки заправки кондиционеров', 90), ('Станки проточки тормозных дисков', 100),
  ('Окрасочные камеры', 110), ('Моечное оборудование', 120), ('Гаражное оборудование и инструмент', 130),
  ('Прочее', 999)
on conflict (name) do nothing;

insert into public.client_statuses (code, name, sort, color) values
  ('new', 'Новый', 10, 'gray'),
  ('contacted', 'Установлен контакт', 20, 'blue'),
  ('in_work', 'В работе', 30, 'amber'),
  ('client', 'Клиент', 40, 'green'),
  ('not_interested', 'Не заинтересован', 50, 'rose'),
  ('closed', 'Не работает / закрыт', 60, 'slate')
on conflict (code) do nothing;

insert into public.request_statuses (code, name, sort, is_final, color) values
  ('new', 'Новая', 10, false, 'blue'),
  ('in_progress', 'Принята в работу', 20, false, 'amber'),
  ('clarification', 'Требуется уточнение', 30, false, 'orange'),
  ('offer_ready', 'Подготовлено предложение', 40, false, 'violet'),
  ('done', 'Выполнена', 50, true, 'green'),
  ('rejected', 'Отклонена', 60, true, 'rose'),
  ('cancelled', 'Отменена', 70, true, 'slate')
on conflict (code) do nothing;

insert into public.deal_stages (code, name, sort, kind) values
  ('need', 'Выявлена потребность', 10, 'open'),
  ('qualification', 'Квалификация', 20, 'open'),
  ('proposal_prep', 'Подготовка предложения', 30, 'open'),
  ('proposal_sent', 'Предложение отправлено', 40, 'open'),
  ('negotiation', 'Переговоры', 50, 'open'),
  ('won', 'Выиграна', 60, 'won'),
  ('lost', 'Проиграна', 70, 'lost')
on conflict (code) do nothing;
