// Сценарии из раздела 18 ТЗ, проверяемые на настоящем PostgreSQL с миграциями и RLS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TEST_DB_URL, TestDb, expectPgError, setupTestDb } from './helpers'

describe.skipIf(!TEST_DB_URL)('База CRM: схема, права и бизнес-логика', () => {
  let db: TestDb
  let admin: string, head: string, repA: string, repB: string, viewer: string, inactive: string
  let dirSto: string, dirTire: string, dirOil: string

  beforeAll(async () => {
    db = await setupTestDb()
    admin = await db.createUser('Админ Тест', 'admin')
    head = await db.createUser('Руководитель Тест', 'head')
    repA = await db.createUser('Иван Петров', 'rep')
    repB = await db.createUser('Асхат Нурланов', 'rep')
    viewer = await db.createUser('Смотрит Всё', 'rep', { canViewAll: true })
    inactive = await db.createUser('Уволен', 'rep', { active: false })
    const dirs = await db.sql<{ id: string; name: string }>('select id, name from directions')
    dirSto = dirs.find((d) => d.name.startsWith('Автосервис'))!.id
    dirTire = dirs.find((d) => d.name.startsWith('Шиномонтаж'))!.id
    dirOil = dirs.find((d) => d.name.startsWith('Пункт замены'))!.id
  })
  afterAll(async () => db?.close())

  // хелпер: торговый представитель создаёт точку
  async function createLocation(uid: string, fields: Record<string, unknown> = {}) {
    return db.as(uid, async (q) => {
      const [l] = await q<{ id: string; manager_id: string }>(
        `insert into locations (name, city, district, source_address, phones, company_id)
         values ($1, $2, $3, $4, $5, $6) returning id, manager_id`,
        [fields.name ?? 'СТО Тест', fields.city ?? 'Алматы', fields.district ?? null, fields.address ?? null,
         fields.phones ?? [], fields.company_id ?? null],
      )
      return l
    })
  }

  it('новый пользователь из Auth получает роль rep и неактивен, даже если в метаданных указан admin', async () => {
    const [u] = await db.sql(`insert into auth.users (email, raw_user_meta_data) values ('hack@test.local', '{"role":"admin"}') returning id`)
    const [p] = await db.sql('select role, is_active from profiles where id = $1', [u.id])
    expect(p).toEqual({ role: 'rep', is_active: false })
  })

  it('1–2. создание и редактирование организации, несколько точек одной компании', async () => {
    const res = await db.as(repA, async (q) => {
      const [c] = await q(`insert into companies (name, legal_name, bin) values ('Авто Плюс', 'ТОО «Авто Плюс»', '123456789012') returning id`)
      const [l1] = await q(`insert into locations (company_id, name, city, source_address) values ($1, 'Авто Плюс Абая', 'Алматы', 'пр. Абая, 10') returning id, manager_id`, [c.id])
      const [l2] = await q(`insert into locations (company_id, name, city, source_address) values ($1, 'Авто Плюс Райымбека', 'Алматы', 'ул. Райымбека, 5') returning id, manager_id`, [c.id])
      await q(`update companies set legal_name = 'ТОО «Авто Плюс KZ»' where id = $1`, [c.id])
      await q(`update locations set name = 'Авто Плюс на Абая', posts_count = 4 where id = $1`, [l1.id])
      const locs = await q('select id, name, manager_id from locations where company_id = $1 order by name', [c.id])
      return { c, l1, l2, locs }
    })
    expect(res.locs).toHaveLength(2)
    expect(res.locs.every((l: any) => l.manager_id === repA)).toBe(true) // создал — значит закреплена за ним
    const logs = await db.sql(`select action, details from activity_logs where entity = 'locations' and entity_id = $1 order by id`, [res.l1.id])
    expect(logs.map((l) => l.action)).toEqual(['insert', 'update'])
    expect(logs[1].details.name.to).toBe('Авто Плюс на Абая')
  })

  it('3. несколько контактов на точке, основной контакт только один; поиск по контакту', async () => {
    const l = await createLocation(repA, { name: 'Контакт-Сервис' })
    await db.as(repA, async (q) => {
      await q(`insert into contacts (location_id, full_name, phone, is_primary) values ($1, 'Ерлан Сагинтаев', '8 (701) 111-22-33', true)`, [l.id])
      await q(`insert into contacts (location_id, full_name, position, is_primary) values ($1, 'Мария Ким', 'Мастер-приёмщик', true)`, [l.id])
    })
    await expectPgError(db.as(repA, (q) => q(`insert into contacts (location_id, position) values ($1, 'Без данных')`, [l.id])), 'contacts_something_known')
    const rows = await db.sql('select full_name, is_primary, phone_norm from contacts where location_id = $1 order by created_at', [l.id])
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.is_primary)).toHaveLength(1)
    expect(rows[0].phone_norm).toBe('77011112233')
    const found = await db.as(repA, (q) => q(`select id from location_list where search_text like '%' || $1 || '%'`, ['77011112233']))
    expect(found.map((f) => f.id)).toContain(l.id)
  })

  it('4. несколько направлений у одной точки (многие-ко-многим)', async () => {
    const l = await createLocation(repA, { name: 'Мульти Сервис' })
    await db.as(repA, (q) => q(`insert into location_directions (location_id, direction_id) values ($1, $2), ($1, $3), ($1, $4)`, [l.id, dirSto, dirTire, dirOil]))
    const [row] = await db.as(repA, (q) => q('select direction_ids from location_list where id = $1', [l.id]))
    expect(row.direction_ids.sort()).toEqual([dirSto, dirTire, dirOil].sort())
    const filtered = await db.as(repA, (q) => q('select id from location_list where direction_ids @> array[$1]::uuid[]', [dirTire]))
    expect(filtered.map((f) => f.id)).toContain(l.id)
  })

  it('5. добавление и редактирование оборудования; бренд может добавить торговый представитель', async () => {
    const l = await createLocation(repA, { name: 'Оборудование-Сервис' })
    const eq = await db.as(repA, async (q) => {
      const [cat] = await q(`select id from equipment_categories where name = 'Подъёмники'`)
      const [brand] = await q(`insert into equipment_brands (name) values ('Launch') returning id`)
      const [e] = await q(`insert into location_equipment (location_id, category_id, brand_id, name, model, quantity, condition)
                           values ($1, $2, $3, 'Двухстоечный подъёмник', 'TLT240', 2, 'working') returning id`, [l.id, cat.id, brand.id])
      await q(`insert into location_equipment (location_id, name, need) values ($1, 'Шиномонтажный станок', 'buy_more')`, [l.id])
      await q(`update location_equipment set condition = 'needs_repair', need = 'replace' where id = $1`, [e.id])
      return q('select name, condition, need, quantity from location_equipment where location_id = $1 order by created_at', [l.id])
    })
    expect(eq).toHaveLength(2)
    expect(eq[0]).toMatchObject({ condition: 'needs_repair', need: 'replace', quantity: 2 })
    // справочник категорий меняет только администратор
    await expectPgError(db.as(repA, (q) => q(`insert into equipment_categories (name) values ('Своя категория')`)), 'row-level security')
  })

  it('6. фотографии: загрузка в свою точку разрешена, в чужую — нет; удалить чужое фото нельзя', async () => {
    const own = await createLocation(repA, { name: 'Фото А' })
    const other = await createLocation(repB, { name: 'Фото Б' })
    await db.as(repA, async (q) => {
      await q(`insert into storage.objects (bucket_id, name) values ('crm-files', $1)`, [`locations/${own.id}/a.jpg`])
      await q(`insert into location_photos (location_id, storage_path, caption) values ($1, $2, 'Фасад')`, [own.id, `locations/${own.id}/a.jpg`])
    })
    await expectPgError(db.as(repA, (q) => q(`insert into storage.objects (bucket_id, name) values ('crm-files', $1)`, [`locations/${other.id}/x.jpg`])), 'row-level security')
    await expectPgError(db.as(repA, (q) => q(`insert into storage.objects (bucket_id, name) values ('crm-files', 'evil/../x.jpg')`)), 'row-level security')
    // repB не видит файл и не может удалить фото repA
    const seen = await db.as(repB, (q) => q(`select id from storage.objects where name like $1`, [`locations/${own.id}/%`]))
    expect(seen).toHaveLength(0)
    const del = await db.as(repB, (q) => q(`delete from location_photos where location_id = $1 returning id`, [own.id]))
    expect(del).toHaveLength(0)
    // автор может удалить своё фото
    const delOwn = await db.as(repA, (q) => q(`delete from location_photos where location_id = $1 returning id`, [own.id]))
    expect(delOwn).toHaveLength(1)
  })

  describe('импорт', () => {
    const rows = [
      { row: 2, data: { name: 'Шина Мастер', city: 'Алматы', district: 'Бостандыкский', address: 'ул. Тимирязева, 42', phones: ['+7 (727) 300-10-10'], external_id: '70000001', category: 'Шиномонтаж', direction_ids: [] as string[] } },
      { row: 3, data: { name: 'Масло Экспресс', city: 'Алматы', address: 'пр. Сейфуллина, 500', phones: ['87012223344'], external_id: '70000002', category: 'Замена масла' } },
      { row: 4, data: { name: 'Без ID Сервис', city: 'Астана', address: 'ул. Кенесары, 1', phones: [] } },
    ]

    async function runImport(uid: string, mode: string, decide: (r: any, p: any) => any, updateFields: string[] = []) {
      return db.as(uid, async (q) => {
        const [job] = await q(`insert into import_jobs (file_name, mode, update_fields, total_rows) values ('2gis.xlsx', $1, $2, $3) returning id`, [mode, updateFields, rows.length])
        const [{ import_preview: preview }] = await q(`select import_preview('2gis', $1::jsonb)`, [JSON.stringify(rows.map((r) => ({ row: r.row, ...r.data })))])
        const batch = rows.map((r) => {
          const p = preview.find((x: any) => x.row === r.row)
          return { row: r.row, raw: r.data, data: r.data, ...decide(r, p) }
        })
        await q(`select import_apply_batch($1, $2::jsonb)`, [job.id, JSON.stringify(batch)])
        const [fin] = await q(`select * from import_finish($1)`, [job.id])
        return { job: fin, preview }
      })
    }
    const byMatch = (mode: 'update' | 'skip') => (_r: any, p: any) =>
      p.match ? { action: mode, location_id: p.location_id } : { action: 'create' }

    it('7–8. импорт создаёт точки с источником и направлениями; права только у импортёра', async () => {
      rows[0].data.direction_ids = [dirTire]
      await expectPgError(db.as(repA, (q) => q(`insert into import_jobs (file_name, mode) values ('x.csv', 'add_new')`)), 'row-level security')
      await expectPgError(db.as(repA, (q) => q(`select import_preview('2gis', '[]'::jsonb)`)), 'Недостаточно прав')
      const { job } = await runImport(admin, 'add_new', byMatch('skip'))
      expect(job).toMatchObject({ status: 'done', created_count: 3, updated_count: 0, error_count: 0 })
      const [loc] = await db.sql(`select l.*, (select count(*) from location_directions d where d.location_id = l.id) as dirs from locations l where external_id = '70000001'`)
      expect(loc).toMatchObject({ source: '2gis', manager_id: null, source_category: 'Шиномонтаж', dirs: '1' })
      expect(loc.phones_norm).toEqual(['77273001010'])
    })

    it('9. повторный импорт того же файла не создаёт дубликатов (даже если клиент прислал «create»)', async () => {
      const before = (await db.sql('select count(*)::int as n from locations'))[0].n
      const { job, preview } = await runImport(admin, 'add_new', byMatch('skip'))
      expect(preview.filter((p: any) => p.match).length).toBe(3)
      expect(job).toMatchObject({ created_count: 0, skipped_count: 3 })
      // устаревшее решение «создать» тоже не создаёт дубль
      const again = await runImport(admin, 'add_new', () => ({ action: 'create' }))
      expect(again.job).toMatchObject({ created_count: 0, skipped_count: 3 })
      expect((await db.sql('select count(*)::int as n from locations'))[0].n).toBe(before)
    })

    it('10. возможный дубликат по телефону показывается пользователю, а не объединяется автоматически', async () => {
      const [{ import_preview: p }] = await db.as(admin, (q) => q(`select import_preview('2gis', $1::jsonb)`, [JSON.stringify([
        { row: 10, name: 'Совсем другое название', city: 'Алматы', address: 'ул. Новая, 1', phones: ['8 727 300 10 10'], external_id: '99999' },
      ])]))
      expect(p[0].match).toBeNull()
      expect(p[0].possible).toHaveLength(1)
      expect(p[0].possible[0]).toMatchObject({ name: 'Шина Мастер', reason: 'Совпал телефон' })
    })

    it('11. ручные данные не перезаписываются: подтверждённый адрес, контакты, пустые значения', async () => {
      const [loc] = await db.sql(`select id from locations where external_id = '70000002'`)
      await db.as(admin, async (q) => {
        await q(`update locations set confirmed_address = 'пр. Сейфуллина, 500, бокс 3', website = 'oil.kz', district = 'Алмалинский' where id = $1`, [loc.id])
        await q(`insert into contacts (location_id, full_name, phone) values ($1, 'Менеджер добавил', '87770000000')`, [loc.id])
      })
      rows[1].data = { ...rows[1].data, name: 'Масло Экспресс (новое)', address: 'пр. Сейфуллина, 500/1', phones: ['87012223344', '+7 700 555 66 77'] } as any
      ;(rows[1].data as any).district = ''
      ;(rows[1].data as any).website = ''
      const { job } = await runImport(admin, 'update_allowed', byMatch('update'), ['name', 'address', 'phones', 'district', 'website'])
      expect(job.updated_count).toBe(3)
      const [after] = await db.sql('select * from locations where id = $1', [loc.id])
      expect(after.confirmed_address).toBe('пр. Сейфуллина, 500, бокс 3')
      expect(after.source_address).toBe('пр. Сейфуллина, 500/1')
      expect(after.name).toBe('Масло Экспресс (новое)')
      expect(after.district).toBe('Алмалинский') // пустое значение не стёрло поле
      expect(after.website).toBe('oil.kz')
      expect(after.phones_norm.sort()).toEqual(['77005556677', '77012223344'])
      const contacts = await db.sql('select full_name from contacts where location_id = $1', [loc.id])
      expect(contacts).toEqual([{ full_name: 'Менеджер добавил' }])
      const log = await db.sql(`select action, count(*)::int n from import_rows group by action order by action`)
      expect(log.find((l) => l.action === 'updated')?.n).toBeGreaterThan(0)
    })

    it('ошибка в одной строке не прерывает порцию и попадает в журнал ошибок', async () => {
      const res = await db.as(admin, async (q) => {
        const [job] = await q(`insert into import_jobs (file_name, mode) values ('bad.csv', 'add_new') returning id`)
        await q(`select import_apply_batch($1, $2::jsonb)`, [job.id, JSON.stringify([
          { row: 2, action: 'create', data: { name: '', city: 'Алматы' } },
          { row: 3, action: 'create', data: { name: 'Нормальная строка', city: 'Шымкент', address: 'ул. Байтурсынова, 7' } },
          { row: 4, action: 'create', data: { name: 'Плохие координаты', lat: 'abc' } },
        ])])
        // повторная отправка той же порции (обрыв связи) ничего не дублирует
        await q(`select import_apply_batch($1, $2::jsonb)`, [job.id, JSON.stringify([
          { row: 3, action: 'create', data: { name: 'Нормальная строка', city: 'Шымкент', address: 'ул. Байтурсынова, 7' } },
        ])])
        const [fin] = await q(`select * from import_finish($1)`, [job.id])
        const errs = await q(`select row_number, message from import_rows where job_id = $1 and action = 'error' order by row_number`, [job.id])
        return { fin, errs }
      })
      expect(res.fin).toMatchObject({ status: 'partial', created_count: 1, error_count: 2 })
      expect(res.errs[0].message).toContain('Не заполнено название')
      expect((await db.sql(`select count(*)::int n from locations where name = 'Нормальная строка'`))[0].n).toBe(1)
    })
  })

  it('12. массовое назначение менеджера с историей; торговый представитель назначать не может', async () => {
    const ids = (await db.sql<{ id: string }>(`select id from locations where manager_id is null`)).map((r) => r.id)
    expect(ids.length).toBeGreaterThanOrEqual(3)
    await expectPgError(db.as(repA, (q) => q('select assign_locations($1, $2)', [ids, repA])), 'Недостаточно прав')
    await expectPgError(db.as(repA, (q) => q('update locations set manager_id = $1 where manager_id = $2', [repB, repA])), 'Недостаточно прав')
    const [{ assign_locations: n }] = await db.as(head, (q) => q('select assign_locations($1, $2, $3)', [ids, repB, 'Территория Алматы']))
    expect(n).toBe(ids.length)
    const hist = await db.sql('select * from manager_assignments where location_id = $1', [ids[0]])
    expect(hist[0]).toMatchObject({ from_manager_id: null, to_manager_id: repB, reason: 'Территория Алматы', assigned_by: head })
    // переназначение сохраняет предыдущую запись
    await db.as(head, (q) => q('select assign_locations($1, $2)', [[ids[0]], repA]))
    expect(await db.sql('select count(*)::int n from manager_assignments where location_id = $1', [ids[0]])).toEqual([{ n: 2 }])
    await db.as(head, (q) => q('select assign_locations($1, $2)', [[ids[0]], repB]))
  })

  it('правила территории: предпросмотр и явное применение только к точкам без менеджера', async () => {
    const l = await db.as(admin, async (q) => {
      const [x] = await q(`insert into locations (name, city, district) values ('Без менеджера Шымкент', 'Шымкент', 'Абайский') returning id`)
      await q(`insert into territory_rules (city, manager_id) values ('шымкент', $1)`, [repA])
      return x
    })
    const preview = await db.as(head, (q) => q('select * from territory_preview(true)'))
    expect(preview.find((p) => p.location_id === l.id)?.new_manager_id).toBe(repA)
    expect((await db.sql('select manager_id from locations where id = $1', [l.id]))[0].manager_id).toBeNull() // без применения ничего не меняется
    await db.as(head, (q) => q('select territory_apply(true)'))
    expect((await db.sql('select manager_id from locations where id = $1', [l.id]))[0].manager_id).toBe(repA)
  })

  describe('планы посещений и визиты', () => {
    let planId: string, locs: string[]
    const date = '2026-11-03'

    it('13. создание плана, добавление точек; повторное нажатие не дублирует визит', async () => {
      locs = [(await createLocation(repA, { name: 'План 1' })).id, (await createLocation(repA, { name: 'План 2' })).id, (await createLocation(repA, { name: 'План 3' })).id]
      planId = await db.as(repA, async (q) => {
        const [{ ensure_visit_plan: id }] = await q('select ensure_visit_plan($1, $2)', [repA, date])
        const [{ ensure_visit_plan: id2 }] = await q('select ensure_visit_plan($1, $2)', [repA, date])
        expect(id2).toBe(id)
        await q('select add_plan_visits($1, $2, $3)', [id, locs, 'Знакомство'])
        const [{ add_plan_visits: again }] = await q('select add_plan_visits($1, $2)', [id, locs])
        expect(again).toBe(0)
        return id
      })
      const visits = await db.sql('select location_id, position, purpose from visits where plan_id = $1 order by position', [planId])
      expect(visits.map((v) => v.location_id)).toEqual(locs)
      expect(visits[0].purpose).toBe('Знакомство')
      const [loc] = await db.sql('select next_visit_date::text from locations where id = $1', [locs[0]])
      expect(loc.next_visit_date).toBe(date)
      // чужой план недоступен
      await expectPgError(db.as(repB, (q) => q('select add_plan_visits($1, $2)', [planId, [locs[0]]])), 'План не найден')
    })

    it('14. порядок точек сохраняется в базе', async () => {
      const ids = (await db.sql('select id from visits where plan_id = $1 order by position', [planId])).map((r) => r.id)
      const reordered = [ids[2], ids[0], ids[1]]
      await db.as(repA, (q) => q('select reorder_plan_visits($1, $2)', [planId, reordered]))
      const after = (await db.sql('select id from visits where plan_id = $1 order by position', [planId])).map((r) => r.id)
      expect(after).toEqual(reordered)
      // repB не может переставить чужие визиты
      await db.as(repB, (q) => q('select reorder_plan_visits($1, $2)', [planId, [ids[1], ids[2], ids[0]]]))
      expect((await db.sql('select id from visits where plan_id = $1 order by position', [planId])).map((r) => r.id)).toEqual(reordered)
    })

    it('15. завершение визита сохраняет результат, обновляет карточку и планирует следующий визит без дублей', async () => {
      const [v] = await db.sql('select id, location_id from visits where plan_id = $1 order by position limit 1', [planId])
      const data = { result: 'Познакомились с владельцем', talked_to: 'Ерлан', needs: 'Нужен подъёмник', interest: 'high',
        agreements: 'Отправить КП', next_step: 'Отправить КП на подъёмник', follow_up_required: true,
        next_contact_date: '2026-11-10', schedule_next_date: '2026-11-17', location_status: 'in_work' }
      await expectPgError(db.as(repB, (q) => q('select complete_visit($1, $2)', [v.id, data])), 'Недостаточно прав')
      const r1 = await db.as(repA, (q) => q('select complete_visit($1, $2) as r', [v.id, data]))
      const r2 = await db.as(repA, (q) => q('select complete_visit($1, $2) as r', [v.id, data]))
      expect(r2[0].r.next_visit_id).toBe(r1[0].r.next_visit_id)
      const [after] = await db.sql('select status, result, interest, actual_at from visits where id = $1', [v.id])
      expect(after).toMatchObject({ status: 'done', result: 'Познакомились с владельцем', interest: 'high' })
      expect(after.actual_at).not.toBeNull()
      const [loc] = await db.sql('select status_code, next_contact_date::text, next_visit_date::text, last_visit_at from locations where id = $1', [v.location_id])
      expect(loc).toMatchObject({ status_code: 'in_work', next_contact_date: '2026-11-10', next_visit_date: '2026-11-17' })
      expect(loc.last_visit_at).not.toBeNull()
      expect((await db.sql(`select count(*)::int n from visits where location_id = $1 and planned_date = '2026-11-17'`, [v.location_id]))[0].n).toBe(1)
    })

    it('перенос визита создаёт визит на новую дату один раз', async () => {
      const [v] = await db.sql(`select id, location_id from visits where plan_id = $1 and status = 'planned' order by position limit 1`, [planId])
      const a = await db.as(repA, (q) => q(`select set_visit_status($1, 'rescheduled', 'Владелец в отъезде', '2026-11-05') as id`, [v.id]))
      const b = await db.as(repA, (q) => q(`select set_visit_status($1, 'rescheduled', 'Владелец в отъезде', '2026-11-05') as id`, [v.id]))
      expect(b[0].id).toBe(a[0].id)
      const [old] = await db.sql('select status, rescheduled_to, status_reason from visits where id = $1', [v.id])
      expect(old).toMatchObject({ status: 'rescheduled', rescheduled_to: a[0].id, status_reason: 'Владелец в отъезде' })
      // из плана можно убрать только не проведённый визит
      const done = await db.sql(`select id from visits where plan_id = $1 and status = 'done'`, [planId])
      expect(await db.as(repA, (q) => q('delete from visits where id = $1 returning id', [done[0].id]))).toHaveLength(0)
    })
  })

  describe('заявки и сделки', () => {
    let loc: string
    beforeAll(async () => {
      loc = (await createLocation(repA, { name: 'Заявки-Сервис' })).id
    })

    it('16. заявка в отдел оборудования: номер, история статуса, уведомления', async () => {
      const req = await db.as(repA, async (q) => {
        const [cat] = await q(`select id from equipment_categories where name = 'Подъёмники'`)
        const [r] = await q(`insert into requests (kind, location_id, category_id, item_name, brand, quantity, budget, urgency, description)
                             values ('equipment', $1, $2, 'Подъёмник 4 т', 'Launch', 1, 2500000, 'high', 'Замена старого') returning *`, [loc, cat.id])
        return r
      })
      expect(req.number).toMatch(/^ОБ-\d{6}$/)
      expect(req.initiator_id).toBe(repA)
      const notes = await db.sql(`select user_id from notifications where kind = 'request_new' and link = $1`, ['/requests/' + req.id])
      expect(notes.map((n) => n.user_id).sort()).toEqual([admin, head].sort())
      await db.as(head, (q) => q(`select change_request_status($1, 'in_progress', 'Взял в работу')`, [req.id]))
      const hist = await db.sql('select from_status, to_status, comment, changed_by from request_status_history where request_id = $1 order by created_at', [req.id])
      expect(hist).toEqual([
        { from_status: null, to_status: 'new', comment: null, changed_by: repA },
        { from_status: 'new', to_status: 'in_progress', comment: 'Взял в работу', changed_by: head },
      ])
      const mine = await db.as(repA, (q) => q(`select title from notifications where kind = 'request_status'`))
      expect(mine[0].title).toContain('Принята в работу')
      // repB заявку не видит
      expect(await db.as(repB, (q) => q('select id from requests where id = $1', [req.id]))).toHaveLength(0)
    })

    it('17. заявка в отдел запчастей с артикулом и ответственным без учётной записи', async () => {
      const r = await db.as(repA, async (q) => (await q(`insert into requests (kind, location_id, item_name, article, brand, quantity, assignee_name)
                       values ('parts', $1, 'Колодки тормозные', 'GDB1550', 'TRW', 4, 'Отдел запчастей: Алия') returning *`, [loc]))[0])
      expect(r.number).toMatch(/^ЗЧ-\d{6}$/)
      expect(r.status_code).toBe('new')
      // заявку на чужого клиента создать нельзя
      const foreign = (await createLocation(repB, { name: 'Чужой' })).id
      await expectPgError(db.as(repA, (q) => q(`insert into requests (kind, location_id, item_name) values ('parts', $1, 'x')`, [foreign])), 'row-level security')
    })

    it('18. потенциальная сделка; «проиграна» требует причину; сумма не считается выручкой', async () => {
      const d = await db.as(repA, async (q) => {
        const [x] = await q(`insert into deals (location_id, title, product, amount, stage_code, next_action_date)
                             values ($1, 'Подъёмник для СТО', 'Подъёмник 4 т', 2500000, 'need', '2026-01-01') returning *`, [loc])
        return x
      })
      await expectPgError(db.as(repA, (q) => q(`update deals set stage_code = 'lost' where id = $1`, [d.id])), 'deals_lost_reason')
      expect(d.manager_id).toBe(repA)
      await db.as(repA, (q) => q(`update deals set stage_code = 'lost', lost_reason = 'Купили у конкурента' where id = $1`, [d.id]))
      const [after] = await db.sql('select closed_at from deals where id = $1', [d.id])
      expect(after.closed_at).not.toBeNull()
      await db.as(repA, (q) => q(`insert into deals (location_id, title, amount, stage_code, next_action_date) values ($1, 'Компрессор', 400000, 'negotiation', '2026-01-01')`, [loc]))
    })
  })

  it('19. права ролей: справочники, пользователи, импорт; неактивный пользователь не видит ничего', async () => {
    await expectPgError(db.as(repA, (q) => q(`insert into directions (name) values ('Новое направление')`)), 'row-level security')
    expect(await db.as(head, (q) => q(`update profiles set role = 'admin' where id = $1 returning id`, [repA]))).toHaveLength(0)
    expect(await db.as(repA, (q) => q(`update profiles set role = 'admin' where id = $1 returning id`, [repA]))).toHaveLength(0)
    await db.as(admin, (q) => q(`insert into directions (name, keywords) values ('Развал-схождение', '{развал}')`))
    await expectPgError(db.as(admin, (q) => q(`update profiles set role = 'rep' where id = $1`, [admin])), 'собственную роль')
    expect(await db.as(inactive, (q) => q('select id from locations'))).toHaveLength(0)
    expect(await db.as(inactive, (q) => q('select id from directions'))).toHaveLength(0)
    const [perm] = await db.as(repA, (q) => q('select my_permissions() as p'))
    expect(perm.p).toMatchObject({ role: 'rep', assign: false, import: false, view_all: false })
    // can_import даёт импорт торговому представителю
    const importer = await db.createUser('Импортёр', 'rep', { canImport: true })
    await db.as(importer, (q) => q(`insert into import_jobs (file_name, mode) values ('ok.csv', 'add_new')`))
  })

  it('20. RLS: торговый представитель не получает чужие данные прямым запросом', async () => {
    const b = await createLocation(repB, { name: 'Секретная точка Б', phones: ['87075554433'] })
    await db.as(repB, async (q) => {
      await q(`insert into contacts (location_id, full_name, phone) values ($1, 'Контакт Б', '87075554433')`, [b.id])
      await q(`insert into comments (location_id, body) values ($1, 'Внутренний комментарий Б')`, [b.id])
    })
    const leak = await db.as(repA, async (q) => ({
      locs: await q('select id from locations where id = $1', [b.id]),
      list: await q('select id from location_list where id = $1', [b.id]),
      contacts: await q('select id from contacts where location_id = $1', [b.id]),
      comments: await q('select id from comments where location_id = $1', [b.id]),
      search: await q(`select * from global_search('Секретная')`),
      upd: await q(`update locations set name = 'взлом' where id = $1 returning id`, [b.id]),
      hist: await q('select id from manager_assignments where location_id = $1', [b.id]),
    }))
    expect(leak).toEqual({ locs: [], list: [], contacts: [], comments: [], search: [], upd: [], hist: [] })
    await expectPgError(db.as(repA, (q) => q(`insert into contacts (location_id, full_name) values ($1, 'Подсунутый')`, [b.id])), 'row-level security')
    // can_view_all видит, но не редактирует
    const v = await db.as(viewer, async (q) => ({
      locs: await q('select id from locations where id = $1', [b.id]),
      upd: await q(`update locations set name = 'взлом' where id = $1 returning id`, [b.id]),
    }))
    expect(v.locs).toHaveLength(1)
    expect(v.upd).toHaveLength(0)
    // руководитель видит всё
    expect(await db.as(head, (q) => q('select id from contacts where location_id = $1', [b.id]))).toHaveLength(1)
  })

  it('21. дашборд считает реальные данные с учётом прав', async () => {
    const [{ s: all }] = await db.as(head, (q) => q(`select dashboard_stats('2026-01-01', '2026-12-31') as s`))
    const [{ n: total }] = await db.sql('select count(*)::int n from locations where archived_at is null')
    const [{ n: unassigned }] = await db.sql('select count(*)::int n from locations where archived_at is null and manager_id is null')
    expect(all.locations_total).toBe(total)
    expect(all.locations_unassigned).toBe(unassigned)
    expect(all.visits_done).toBe(1)
    expect(all.requests_new).toBe(1) // ЗЧ новая, ОБ — в работе
    expect(all.requests_in_work).toBe(1)
    expect(all.deals_open).toBe(1)
    expect(Number(all.deals_open_amount)).toBe(400000) // проигранная сделка не входит
    expect(all.overdue_deals).toBe(1)
    const [{ s: mine }] = await db.as(repA, (q) => q(`select dashboard_stats('2026-01-01', '2026-12-31') as s`))
    const [{ n: repTotal }] = await db.sql('select count(*)::int n from locations where archived_at is null and manager_id = $1', [repA])
    expect(mine.locations_total).toBe(repTotal)
    const stats = await db.as(head, (q) => q(`select * from manager_stats('2026-01-01', '2026-12-31')`))
    const a = stats.find((s) => s.manager_id === repA)
    expect(a).toMatchObject({ visits_done: '1', contacted_clients: '1', requests_created: '2', deals_created: '2' })
    // торговый представитель видит только себя
    const own = await db.as(repA, (q) => q(`select manager_id from manager_stats('2026-01-01', '2026-12-31')`))
    expect(own.map((o) => o.manager_id)).toEqual([repA])
  })

  it('22. обязательные поля и защита от повторной отправки', async () => {
    const l = await createLocation(repA, { name: 'Повторы' })
    await expectPgError(db.as(repA, (q) => q(`insert into locations (name) values ('   ')`)), 'locations_name_check')
    await expectPgError(db.as(repA, (q) => q(`insert into requests (kind, location_id, item_name) values ('equipment', $1, '')`, [l.id])), 'requests_item_name_check')
    await expectPgError(db.as(repA, (q) => q(`insert into companies (name, bin) values ('X', '123')`)), 'companies_bin_check')
    const key = randomUUID()
    await db.as(repA, (q) => q(`insert into requests (kind, location_id, item_name, client_request_id) values ('parts', $1, 'Фильтр', $2)`, [l.id, key]))
    await expectPgError(db.as(repA, (q) => q(`insert into requests (kind, location_id, item_name, client_request_id) values ('parts', $1, 'Фильтр', $2)`, [l.id, key])), 'requests_client_request_id_key')
    expect((await db.sql('select count(*)::int n from requests where client_request_id = $1', [key]))[0].n).toBe(1)
  })

  it('архивирование клиента доступно только руководству и попадает в журнал', async () => {
    const l = await createLocation(repA, { name: 'В архив' })
    await expectPgError(db.as(repA, (q) => q('update locations set archived_at = now() where id = $1', [l.id])), 'архивирования')
    await db.as(head, (q) => q('update locations set archived_at = now() where id = $1', [l.id]))
    const [log] = await db.sql(`select action from activity_logs where entity_id = $1 order by id desc limit 1`, [l.id])
    expect(log.action).toBe('archive')
  })
})

describe.skipIf(!TEST_DB_URL)('База CRM: общие гарантии безопасности', () => {
  let db: TestDb
  beforeAll(async () => { db = await setupTestDb() })
  afterAll(async () => db?.close())

  it('RLS включена на всех таблицах public, у anon нет прав, представление работает с правами пользователя', async () => {
    const noRls = await db.sql(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)
    expect(noRls).toEqual([])
    const anon = await db.sql(`select table_name, privilege_type from information_schema.role_table_grants
                               where grantee = 'anon' and table_schema = 'public'`)
    expect(anon).toEqual([])
    const [view] = await db.sql(`select reloptions from pg_class where relname = 'location_list'`)
    expect(view.reloptions).toContain('security_invoker=true')
    // анонимный пользователь не может вызывать функции CRM
    const anonFns = await db.sql(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                  where n.nspname in ('public', 'app') and has_function_privilege('anon', p.oid, 'execute')`)
    expect(anonFns).toEqual([])
  })

  it('руководитель открывает торговому представителю всю базу; торговый сам себе — нет', async () => {
    const head = await db.createUser('Рук', 'head')
    const rep = await db.createUser('Реп', 'rep')
    await expectPgError(db.as(rep, (q) => q('select set_rep_view_all($1, true)', [rep])), 'Недостаточно прав')
    await db.as(head, (q) => q('select set_rep_view_all($1, true)', [rep]))
    expect((await db.sql('select can_view_all from profiles where id = $1', [rep]))[0].can_view_all).toBe(true)
    await expectPgError(db.as(head, (q) => q('select set_rep_view_all($1, true)', [head])), 'только торговым')
  })

  it('нормализация в браузере совпадает с нормализацией в базе', async () => {
    const { normAddress, normText } = await import('../../src/lib/import/normalize')
    const { normPhone } = await import('../../src/lib/phone')
    const samples = ['г. Алматы, ул. Тимирязева, д. 42', 'пр-т Абая 10, р-н Бостандыкский', 'мкр. Самал-2, 58', 'Ёлочная улица, 5/1', 'ТОО «Авто-Плюс»', '  ']
    for (const s of samples) {
      const [r] = await db.sql('select app.norm_text($1) t, app.norm_address($1) a', [s])
      expect([normText(s), normAddress(s)]).toEqual([r.t, r.a])
    }
    for (const p of ['8 (701) 123-45-67', '+7 727 300 10 10', '7011234567', '123']) {
      const [r] = await db.sql('select app.norm_phone($1) p', [p])
      expect(normPhone(p)).toBe(r.p)
    }
  })
})
