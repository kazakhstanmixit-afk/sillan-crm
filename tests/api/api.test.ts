// Сквозная проверка запросов интерфейса через настоящий REST API (PostgREST — тот же движок, что в Supabase)
// и клиент @supabase/supabase-js. Проверяет форму запросов: фильтры, вложенные выборки, RPC, права.
// Запуск: TEST_DATABASE_URL=... POSTGREST_BIN=/path/to/postgrest npm run test:api
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import http from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { setupTestDb, TEST_DB_URL, type TestDb } from '../db/helpers'

const BIN = process.env.POSTGREST_BIN
const SECRET = 'test-secret-test-secret-test-secret-123456'

function jwt(sub: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!TEST_DB_URL || !BIN)('REST API: запросы интерфейса', () => {
  let db: TestDb
  let pgrst: ChildProcess
  let proxy: http.Server
  let baseUrl: string
  let admin: string, rep: string, repB: string
  const clients: Record<string, SupabaseClient> = {}
  const as = (uid: string) => (clients[uid] ??= createClient(baseUrl, 'anon-key', { accessToken: async () => jwt(uid) }))

  beforeAll(async () => {
    db = await setupTestDb()
    admin = await db.createUser('Админ', 'admin')
    rep = await db.createUser('Торговый Один', 'rep')
    repB = await db.createUser('Торговый Два', 'rep')
    const dbName = (await db.sql('select current_database() as n'))[0].n
    const u = new URL(TEST_DB_URL!)
    const host = u.searchParams.get('host') ?? u.hostname
    const port = 39000 + Math.floor(Math.random() * 1000)
    pgrst = spawn(BIN!, [], {
      env: {
        ...process.env,
        PGRST_DB_URI: `postgresql://authenticator@/${dbName}?host=${encodeURIComponent(host)}&port=${u.port || 5432}`,
        PGRST_DB_SCHEMAS: 'public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_JWT_SECRET: SECRET,
        PGRST_SERVER_PORT: String(port),
        PGRST_DB_POOL: '5',
      },
      stdio: 'pipe',
    })
    let log = ''
    pgrst.stderr?.on('data', (d) => (log += d))
    pgrst.stdout?.on('data', (d) => (log += d))
    // supabase-js обращается к /rest/v1 — проксируем на PostgREST
    proxy = http.createServer((req, res) => {
      const path = (req.url ?? '').replace(/^\/rest\/v1/, '') || '/'
      const fwd = http.request({ host: '127.0.0.1', port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => {
        res.writeHead(r.statusCode ?? 500, r.headers)
        r.pipe(res)
      })
      fwd.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
      req.pipe(fwd)
    })
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`)
        if (r.status < 500) return
      } catch { /* ещё запускается */ }
      await wait(250)
    }
    throw new Error('PostgREST не запустился: ' + log)
  })
  afterAll(async () => {
    pgrst?.kill()
    proxy?.close()
    await db?.close()
  })

  let locId = ''
  let dirTire = ''

  it('создание клиента одной транзакцией (create_location) и повторная отправка', async () => {
    const s = as(rep)
    const { data: dirs } = await s.from('directions').select('*').order('sort')
    dirTire = dirs!.find((d: { name: string }) => d.name.startsWith('Шиномонтаж')).id
    const key = randomUUID()
    const payload = {
      client_request_id: key, name: 'СТО «Мотор»', city: 'Алматы', district: 'Алмалинский', address: 'ул. Толе би, 100', phones: ['8 701 555 44 33'],
      direction_ids: [dirTire], new_company: { name: 'Мотор Групп', legal_name: 'ТОО «Мотор Групп»', bin: '123456789012' },
      contact: { full_name: 'Бахыт', phone: '87015554433', decision_role: 'decision_maker' }, comment: 'Первый визит прошёл хорошо',
    }
    const r1 = await s.rpc('create_location', { p: payload })
    expect(r1.error).toBeNull()
    const r2 = await s.rpc('create_location', { p: payload })
    expect(r2.data).toBe(r1.data)
    locId = r1.data
  })

  it('список клиентов: поиск по телефону, направление, сортировка, пагинация, счётчик', async () => {
    const s = as(rep)
    const res = await s.from('location_list').select('id,name,company_name,legal_name,direction_ids,contact_name,contact_phone,manager_name', { count: 'exact' })
      .ilike('search_text', '%77015554433%').contains('direction_ids', [dirTire]).is('archived_at', null)
      .order('manager_name', { ascending: true, nullsFirst: false }).order('id').range(0, 49)
    expect(res.error).toBeNull()
    expect(res.count).toBe(1)
    expect(res.data![0]).toMatchObject({ name: 'СТО «Мотор»', legal_name: 'ТОО «Мотор Групп»', contact_name: 'Бахыт', manager_name: 'Торговый Один' })
    const none = await as(repB).from('location_list').select('id').eq('id', locId)
    expect(none.data).toEqual([])
    const opts = await s.rpc('location_filter_options')
    expect(opts.data.cities).toEqual(['Алматы'])
    const comp = await s.from('companies').select('id,name').or('name.ilike.%мотор%,legal_name.ilike.%мотор%')
    expect(comp.data).toHaveLength(1)
  })

  it('глобальный поиск и карточка: контакты, услуги, оборудование, комментарии', async () => {
    const s = as(rep)
    const g = await s.rpc('global_search', { p_q: '+7 (701) 555-44-33', p_limit: 6 })
    expect(g.error).toBeNull()
    expect(g.data.map((x: { kind: string }) => x.kind)).toContain('location')
    const { data: srv } = await s.from('services').select('id').limit(2)
    const links = await s.rpc('set_location_links', { p_location: locId, p_direction_ids: [dirTire], p_service_ids: srv!.map((x: { id: string }) => x.id) })
    expect(links.error).toBeNull()
    const upd = await s.from('contacts').insert({ location_id: locId, full_name: 'Мастер Асет', phone: '+77001112233' }).select('id')
    expect(upd.data).toHaveLength(1)
    const eq = await s.from('location_equipment').insert({ location_id: locId, name: 'Подъёмник', quantity: 2 }).select('id')
    expect(eq.error).toBeNull()
    const cm = await s.from('comments').insert({ location_id: locId, kind: 'agreement', body: 'Перезвонить', next_contact_date: '2026-11-20' }).select('id')
    expect(cm.error).toBeNull()
    const loc = await s.from('locations').select('next_contact_date').eq('id', locId).single()
    expect(loc.data!.next_contact_date).toBe('2026-11-20')
    const hist = await s.from('activity_logs').select('*').eq('location_id', locId).order('created_at', { ascending: false }).limit(300)
    expect(hist.data!.length).toBeGreaterThan(3)
    const foreign = await as(repB).from('contacts').insert({ location_id: locId, full_name: 'Чужой' }).select('id')
    expect(foreign.error?.message).toMatch(/row-level security/)
  })

  it('план посещений: добавление, вложенная выборка точки, порядок, результат, перенос', async () => {
    const s = as(rep)
    const { data: planId } = await s.rpc('ensure_visit_plan', { p_manager: rep, p_date: '2026-11-04' })
    const second = await s.rpc('create_location', { p: { name: 'Шиномонтаж 24', city: 'Алматы', address: 'пр. Райымбека, 1' } })
    await s.rpc('add_plan_visits', { p_plan: planId, p_location_ids: [locId, second.data], p_purpose: 'Знакомство' })
    const v = await s.from('visits').select('*, location:locations(id,name,city,district,source_address,confirmed_address,lat,lng,phones,status_code,manager_id)').eq('plan_id', planId).order('position')
    expect(v.error).toBeNull()
    expect(v.data!.map((x: { location: { name: string } }) => x.location.name)).toEqual(['СТО «Мотор»', 'Шиномонтаж 24'])
    const ids = v.data!.map((x: { id: string }) => x.id).reverse()
    expect((await s.rpc('reorder_plan_visits', { p_plan: planId, p_ids: ids })).error).toBeNull()
    const after = await s.from('visits').select('id').eq('plan_id', planId).order('position')
    expect(after.data!.map((x: { id: string }) => x.id)).toEqual(ids)
    const done = await s.rpc('complete_visit', { p_visit: ids[1], p_data: { status: 'done', actual_at: new Date().toISOString(), result: 'Интерес к подъёмнику', interest: 'high', contact_id: '', schedule_next_date: '2026-11-18', follow_up_required: true, next_contact_date: '', location_status: '' } })
    expect(done.error).toBeNull()
    expect(done.data.next_visit_id).toBeTruthy()
    const resch = await s.rpc('set_visit_status', { p_visit: ids[0], p_status: 'rescheduled', p_reason: 'Закрыто', p_new_date: '2026-11-06' })
    expect(resch.error).toBeNull()
    const hist = await s.from('visits').select('*, location:locations(id,name)', { count: 'exact' }).gte('planned_date', '2026-11-01').lte('planned_date', '2026-11-30').order('planned_date', { ascending: false }).range(0, 49)
    expect(hist.count).toBe(4)
  })

  it('заявки: создание, защита от повтора, список с фильтрами, смена статуса, уведомления', async () => {
    const s = as(rep)
    const key = randomUUID()
    const row = { kind: 'equipment', location_id: locId, client_request_id: key, item_name: 'Подъёмник 4 т', quantity: 1, budget: 2500000, urgency: 'high' }
    const r1 = await s.from('requests').insert(row).select('id, number').single()
    expect(r1.error).toBeNull()
    const r2 = await s.from('requests').insert(row).select('id, number').single()
    expect(r2.error?.code).toBe('23505')
    const list = await s.from('requests').select('*, location:locations(id,name,city)', { count: 'exact' })
      .not('status_code', 'in', '(done,rejected,cancelled)').or('number.ilike.%ОБ%,item_name.ilike.%ОБ%').order('created_at', { ascending: false }).range(0, 49)
    expect(list.error).toBeNull()
    expect(list.count).toBe(1)
    const one = await s.from('requests').select('*, location:locations(id,name,city), contact:contacts(full_name,phone)').eq('id', r1.data!.id).maybeSingle()
    expect(one.data!.location.name).toBe('СТО «Мотор»')
    expect((await as(admin).rpc('change_request_status', { p_request: r1.data!.id, p_status: 'in_progress', p_comment: 'Взяли' })).error).toBeNull()
    const notes = await s.from('notifications').select('*').order('created_at', { ascending: false }).limit(30)
    expect(notes.data![0].title).toContain('Принята в работу')
    const read = await s.rpc('mark_notifications_read', { p_ids: null })
    expect(read.data).toBe(1)
    const comment = await s.from('request_comments').insert({ request_id: r1.data!.id, body: 'Нужен срочно', author_id: rep }).select('id')
    expect(comment.error).toBeNull()
  })

  it('сделки: создание, список открытых, сводка по стадиям', async () => {
    const s = as(rep)
    const ins = await s.from('deals').insert({ location_id: locId, title: 'Подъёмник', amount: 2500000, stage_code: 'need', next_action_date: '2026-01-10', client_request_id: randomUUID() }).select('id')
    expect(ins.error).toBeNull()
    const lost = await s.from('deals').update({ stage_code: 'lost' }).eq('id', ins.data![0].id).select('id')
    expect(lost.error?.code).toBe('23514')
    const list = await s.from('deals').select('*, location:locations(id,name,city)', { count: 'exact' }).in('stage_code', ['need', 'qualification'])
      .order('next_action_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).range(0, 49)
    expect(list.count).toBe(1)
  })

  it('импорт через API: задание, проверка совпадений, порции, отчёт', async () => {
    const s = as(admin)
    const job = await s.from('import_jobs').insert({ file_name: '2gis.csv', source: '2gis', mode: 'add_new', update_fields: [], mapping: { 'Название': 'name' }, total_rows: 2 }).select('id').single()
    expect(job.error).toBeNull()
    const prev = await s.rpc('import_preview', { p_source: '2gis', p_rows: [
      { row: 2, name: 'Мотор', city: 'Алматы', address: 'Толе би 100', external_id: null, phones: ['+7 701 555 44 33'] },
      { row: 3, name: 'Новый сервис', city: 'Астана', address: 'ул. Сарыарка, 5', external_id: '777', phones: [] },
    ] })
    expect(prev.error).toBeNull()
    expect(prev.data[0].possible[0].reason).toBe('Совпал телефон')
    const batch = await s.rpc('import_apply_batch', { p_job: job.data!.id, p_rows: [
      { row: 2, action: 'skip', message: 'Пропущено (решение пользователя)', raw: { 'Название': 'Мотор' }, data: { name: 'Мотор' } },
      { row: 3, action: 'create', raw: { 'Название': 'Новый сервис' }, data: { name: 'Новый сервис', city: 'Астана', address: 'ул. Сарыарка, 5', external_id: '777', phones: [], direction_ids: [dirTire] } },
    ] })
    expect(batch.error).toBeNull()
    const fin = await s.rpc('import_finish', { p_job: job.data!.id, p_failed: false })
    expect(fin.data).toMatchObject({ status: 'done', created_count: 1, skipped_count: 1 })
    const rows = await s.from('import_rows').select('row_number,action,message,raw,location_id').eq('job_id', job.data!.id).in('action', ['error', 'conflict', 'skipped']).order('row_number').range(0, 999)
    expect(rows.data).toHaveLength(1)
    expect((await as(rep).from('import_jobs').insert({ file_name: 'x', mode: 'add_new' }).select('id')).error).not.toBeNull()
  })

  it('распределение, дашборд, аналитика, справочники, профиль', async () => {
    const s = as(admin)
    const { data: unassigned } = await s.from('location_list').select('id').is('manager_id', null)
    const asg = await s.rpc('assign_locations', { p_ids: unassigned!.map((x: { id: string }) => x.id), p_manager: repB, p_reason: 'Астана' })
    expect(asg.data).toBe(unassigned!.length)
    const hist = await s.from('manager_assignments').select('*, location:locations(id,name,city)').order('created_at', { ascending: false }).limit(200)
    expect(hist.data![0].location).toBeTruthy()
    const dash = await s.rpc('dashboard_stats', { p_from: '2026-01-01', p_to: '2026-12-31', p_manager: null, p_city: null, p_direction: null })
    expect(dash.error).toBeNull()
    expect(dash.data.locations_total).toBe(3)
    expect(dash.data.requests_in_work).toBe(1)
    const mstats = await s.rpc('manager_stats', { p_from: '2026-01-01', p_to: '2026-12-31', p_city: null, p_direction: null })
    expect(mstats.error).toBeNull()
    const terr = await s.rpc('territory_preview', { p_only_unassigned: true })
    expect(terr.error).toBeNull()
    const dict = await s.from('directions').insert({ name: 'Развал-схождение', keywords: ['развал'], sort: 100, is_active: true }).select('id')
    expect(dict.error).toBeNull()
    const repDict = await as(rep).from('directions').insert({ name: 'Нельзя' }).select('id')
    expect(repDict.error).not.toBeNull()
    expect((await as(rep).rpc('update_my_profile', { p_full_name: 'Торговый Первый', p_phone: '+7 700 000 00 00' })).error).toBeNull()
    const prof = await as(rep).from('profiles').select('full_name').eq('id', rep).single()
    expect(prof.data!.full_name).toBe('Торговый Первый')
    const perms = await as(rep).rpc('my_permissions')
    expect(perms.data).toMatchObject({ role: 'rep', import: false })
    const bulk = await s.rpc('bulk_update_locations', { p_ids: [locId], p_patch: { status_code: 'in_work' } })
    expect(bulk.data).toBe(1)
    const anon = createClient(baseUrl, 'anon-key')
    const leak = await anon.from('locations').select('id')
    expect(leak.error).not.toBeNull()
  })
})
