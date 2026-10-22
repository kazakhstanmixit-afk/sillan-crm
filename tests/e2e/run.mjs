// Сквозная проверка интерфейса в браузере (Chromium) на локальном PostgreSQL + PostgREST.
// Запуск: TEST_DATABASE_URL=... POSTGREST_BIN=... CHROMIUM=... SHOTS=папка node tests/e2e/run.mjs
import { spawn, execSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { chromium } from 'playwright-core'

const root = join(import.meta.dirname, '..', '..')
const { TEST_DATABASE_URL, POSTGREST_BIN, CHROMIUM, SHOTS = '/tmp/e2e-shots' } = process.env
mkdirSync(SHOTS, { recursive: true })
const SECRET = 'e2e-secret-e2e-secret-e2e-secret-1234567'
const GW = 54400 + Math.floor(Math.random() * 500)
const PG_PORT = GW + 1
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('•', ...a)

// 1. база
const admin = new pg.Client({ connectionString: TEST_DATABASE_URL })
await admin.connect()
const dbName = `crm_e2e_${Date.now()}`
await admin.query(`create database ${dbName}`)
const u = new URL(TEST_DATABASE_URL)
u.pathname = '/' + dbName
const db = new pg.Pool({ connectionString: u.toString() })
for (const f of ['tests/db/supabase_stub.sql', ...readdirSync(join(root, 'supabase/migrations')).sort().map((f) => 'supabase/migrations/' + f)]) {
  await db.query(readFileSync(join(root, f), 'utf8'))
}
async function user(email, name, role) {
  const { rows } = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`, [email, name])
  await db.query('update profiles set role = $2, is_active = true, full_name = $3 where id = $1', [rows[0].id, role, name])
  return rows[0].id
}
await user('admin@e2e.local', 'Айгерим Админова', 'admin')
const repId = await user('rep@e2e.local', 'Ерлан Торговый', 'rep')
log('база готова', dbName)

// 2. сервисы
const host = u.searchParams.get('host') ?? u.hostname
const procs = []
procs.push(spawn(POSTGREST_BIN, [], { env: { ...process.env, PGRST_DB_URI: `postgresql://authenticator@/${dbName}?host=${encodeURIComponent(host)}&port=${u.port || 5432}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET, PGRST_SERVER_PORT: String(PG_PORT) }, stdio: 'ignore' }))
execSync('npx vite build --outDir dist-e2e --emptyOutDir', { cwd: root, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `http://127.0.0.1:${GW}`, VITE_SUPABASE_ANON_KEY: 'e2e-anon-key' } })
procs.push(spawn('node', [join(root, 'tests/e2e/gateway.mjs')], { env: { ...process.env, PORT: String(GW), PGRST_PORT: String(PG_PORT), DB_URL: u.toString(), JWT_SECRET: SECRET, DIST: join(root, 'dist-e2e') }, stdio: 'inherit' }))
await wait(2500)
log('шлюз и PostgREST запущены')

// 3. браузер
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'ru-RU', timezoneId: 'Asia/Almaty' })
const page = await ctx.newPage()
const problems = []
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`) })
const base = `http://127.0.0.1:${GW}`
const shot = (name) => page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true })
const results = []
async function step(name, fn) {
  try {
    await fn()
    results.push(['OK', name])
    log('OK  ', name)
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n')[0]])
    log('FAIL', name, e.message.split('\n')[0])
    await shot('fail-' + results.length).catch(() => {})
  }
}
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 10000 })

async function login(email) {
  await page.goto(base + '/login')
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Пароль').fill('e2e-password')
  await page.getByRole('button', { name: 'Войти' }).click()
  await page.getByText('Здравствуйте').waitFor({ timeout: 15000 })
}
async function logout() {
  await page.getByRole('button', { name: 'Выйти' }).first().click()
  await page.getByRole('button', { name: 'Войти' }).waitFor()
}

const csv = [
  'Название;Рубрики;Город;Район;Адрес;Телефон;ID;Ссылка на 2ГИС',
  'Шина Мастер;Шиномонтаж, Правка дисков;Алматы;Бостандыкский;ул. Тимирязева, 42;+7 727 300 10 10;70000001;https://2gis.kz/almaty/firm/70000001',
  'Автосервис Мотор;Автосервис, Компьютерная диагностика;Алматы;Алмалинский;ул. Толе би, 100;8 701 555 44 33;70000002;',
  ';Автомойки;Алматы;;ул. Абая, 1;;70000003;',
].join('\n')
const csvPath = join(SHOTS, '2gis.csv')
writeFileSync(csvPath, csv)

await step('неверный пароль — понятная ошибка', async () => {
  await page.goto(base + '/login')
  await page.getByLabel('E-mail').fill('admin@e2e.local')
  await page.getByLabel('Пароль').fill('wrong-pass')
  await page.getByRole('button', { name: 'Войти' }).click()
  await page.getByText('Неверный e-mail или пароль').waitFor()
})

await step('вход администратора, пустой дашборд', async () => {
  await login('admin@e2e.local')
  await page.getByText('В базе пока нет клиентов').waitFor()
  await shot('01-dashboard-empty')
})

await step('импорт CSV: сопоставление, проверка, импорт', async () => {
  await page.goto(base + '/import')
  await page.locator('input[type=file]').setInputFiles(csvPath)
  await page.getByText('Сопоставление столбцов').waitFor()
  await shot('02-import-mapping')
  await page.getByRole('button', { name: 'Проверить данные' }).click()
  await page.getByText('Режим импорта').waitFor()
  await shot('03-import-review')
  await page.getByRole('button', { name: /Импортировать: создать 2/ }).click()
  await page.getByText('Импорт завершён').first().waitFor({ timeout: 20000 })
  await shot('04-import-done')
  const { rows } = await db.query(`select count(*)::int n, count(*) filter (where exists (select 1 from location_directions d where d.location_id = l.id))::int with_dir from locations l`)
  if (rows[0].n !== 2) throw new Error('ожидалось 2 точки, в базе ' + rows[0].n)
  if (rows[0].with_dir !== 2) throw new Error('направления не подобраны')
})

await step('повторный импорт того же файла не создаёт дублей', async () => {
  await page.getByRole('button', { name: 'Новый импорт' }).click()
  await page.locator('input[type=file]').setInputFiles(csvPath)
  await page.getByRole('button', { name: 'Проверить данные' }).click()
  await page.getByText('Найдено в базе: 2').waitFor()
  const btn = page.getByRole('button', { name: /Импортировать: создать 0, обновить 0/ })
  if (!(await btn.isDisabled())) throw new Error('кнопка импорта должна быть неактивна — нечего создавать')
  const { rows } = await db.query('select count(*)::int n from locations')
  if (rows[0].n !== 2) throw new Error('появились дубли')
})

await step('журнал импорта', async () => {
  await page.goto(base + '/import')
  await page.getByRole('tab', { name: 'Журнал импорта' }).click()
  await page.getByText('2gis.csv').first().waitFor()
})

await step('список клиентов: поиск по телефону и фильтр без ответственного', async () => {
  await page.goto(base + '/clients')
  await page.getByText('Шина Мастер').waitFor()
  await page.getByLabel('Поиск по клиентам').fill('8 (727) 300-10-10')
  await page.waitForURL(/q=/)
  await page.getByText('1–1 из 1').waitFor()
  await page.getByLabel('Поиск по клиентам').fill('')
  await page.getByLabel('Ответственный').selectOption('none')
  await page.getByText('1–2 из 2').waitFor()
  await shot('05-clients')
})

await step('массовое назначение ответственного с предпросмотром', async () => {
  await page.getByLabel('Выбрать все на странице').check()
  await page.getByRole('button', { name: 'Назначить ответственного' }).click()
  await page.getByText('Сейчас закреплены за:').waitFor()
  await page.getByRole('dialog').getByLabel('Новый ответственный').selectOption({ label: 'Ерлан Торговый' })
  await page.getByRole('dialog').getByLabel(/Причина/).fill('Территория Алматы')
  await page.getByRole('button', { name: 'Назначить (2)' }).click()
  await toast('Ответственный изменён у 2 клиентов')
  const { rows } = await db.query('select count(*)::int n from manager_assignments where reason = $1', ['Территория Алматы'])
  if (rows[0].n !== 2) throw new Error('история назначений не записана')
})

await step('карточка клиента: контакт, оборудование, история', async () => {
  await page.goto(base + '/clients')
  await page.getByRole('link', { name: 'Автосервис Мотор' }).click()
  await page.getByRole('heading', { name: 'Автосервис Мотор' }).waitFor()
  await page.getByRole('tab', { name: 'Контакты' }).click()
  await page.getByRole('button', { name: 'Добавить контакт' }).click()
  await page.getByRole('dialog').getByLabel('ФИО').fill('Бахыт Сейткали')
  await page.getByRole('dialog').getByLabel('Телефон').fill('+7 701 222 33 44')
  await page.getByRole('dialog').getByLabel('Роль в принятии решения').selectOption('decision_maker')
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click()
  await toast('Контакт добавлен')
  await page.getByText('Принимает решение').waitFor()
  await page.getByRole('tab', { name: 'Оборудование' }).click()
  await page.getByRole('button', { name: 'Добавить' }).click()
  await page.getByRole('dialog').getByLabel(/Название/).fill('Двухстоечный подъёмник')
  await page.getByRole('dialog').getByLabel('Категория').selectOption({ label: 'Подъёмники' })
  await page.getByRole('dialog').getByLabel('Потребность').selectOption('replace')
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click()
  await page.getByRole('cell', { name: 'Двухстоечный подъёмник' }).waitFor()
  await page.getByRole('tab', { name: 'История' }).click()
  await page.getByText('История ответственных').waitFor()
  await page.getByText('Ерлан Торговый').first().waitFor()
  await shot('06-client-history')
})

await step('настройки, команда, аналитика открываются у администратора', async () => {
  await page.goto(base + '/settings')
  await page.getByRole('tab', { name: 'Справочники' }).click()
  await page.getByRole('cell', { name: 'Автосервис / СТО' }).waitFor()
  await page.goto(base + '/team')
  await page.getByText('Закреплено клиентов').waitFor()
  await page.goto(base + '/analytics')
  await page.getByText('Как считаются показатели').waitFor()
  await shot('07-analytics')
})

await step('выход и вход торгового представителя: видит своих клиентов', async () => {
  await logout()
  await login('rep@e2e.local')
  await page.goto(base + '/clients')
  await page.getByText('1–2 из 2').waitFor()
})

const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10) })()

await step('план посещений: добавить из карточки, порядок сохраняется', async () => {
  await page.getByRole('link', { name: 'Шина Мастер' }).click()
  await page.getByRole('button', { name: 'В план' }).click()
  await page.getByRole('dialog').getByLabel('Цель визита').fill('Презентация балансировочного станка')
  await page.getByRole('dialog').getByRole('button', { name: 'Добавить' }).click()
  await page.waitForURL(/\/plan/)
  await page.getByRole('button', { name: 'Добавить точки' }).click()
  await page.getByRole('dialog').getByText('Автосервис Мотор').click()
  await page.getByRole('dialog').getByRole('button', { name: /Добавить \(1\)/ }).click()
  await toast('Добавлено точек: 1')
  await page.getByRole('button', { name: 'Ниже' }).first().click()
  await wait(800)
  await page.reload()
  const first = await page.locator('ol > li').first().textContent()
  if (!first.includes('Автосервис Мотор')) throw new Error('порядок не сохранился после перезагрузки')
  await shot('08-plan')
})

await step('результат визита со смартфона + следующий визит', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Результат' }).first().click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Фактический результат').fill('Встретились с владельцем, интерес к подъёмнику')
  await dlg.getByLabel('Заинтересованность в покупке').selectOption('high')
  await dlg.getByLabel('Выявленные потребности').fill('Замена подъёмника')
  await dlg.getByLabel('Запланировать следующий визит на').fill(tomorrow)
  await shot('09-visit-result-mobile')
  await dlg.getByRole('button', { name: 'Сохранить результат' }).click()
  await toast('Результат визита сохранён')
  await dlg.getByRole('button', { name: 'Заявку' }).click()
})

await step('заявка в отдел оборудования из результата визита', async () => {
  const dlg = page.getByRole('dialog', { name: 'Новая заявка' })
  await dlg.getByLabel(/Оборудование или желаемое решение/).fill('Подъёмник 4 т')
  await dlg.getByLabel(/бюджет/).fill('2500000')
  await dlg.getByRole('button', { name: 'Создать заявку' }).click()
  await page.waitForURL(/\/requests\//)
  await page.getByRole('heading', { name: /Заявка ОБ-\d{6}/ }).waitFor()
  await shot('10-request-mobile')
  await page.setViewportSize({ width: 1360, height: 900 })
})

await step('потенциальная сделка из карточки', async () => {
  await page.goto(base + '/clients')
  await page.getByRole('link', { name: 'Автосервис Мотор' }).click()
  await page.getByRole('button', { name: 'Сделка' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel(/Название сделки/).fill('Подъёмник и стенд развал-схождения')
  await dlg.getByLabel(/Предполагаемая сумма/).fill('4200000')
  await dlg.getByRole('button', { name: 'Сохранить' }).click()
  await toast('Сделка создана')
  await page.goto(base + '/deals')
  await page.getByText('Подъёмник и стенд развал-схождения').waitFor()
})

await step('дашборд торгового представителя считает реальные данные', async () => {
  await page.goto(base + '/')
  await page.getByText('Показатели по вашим клиентам').waitFor()
  const card = page.locator('div', { hasText: /^Выполнено визитов/ }).first()
  await card.waitFor()
  const txt = await page.textContent('main')
  if (!/Выполнено визитов\s*1/.test(txt)) throw new Error('не вижу «Выполнено визитов 1»')
  if (!/Открытых сделок\s*1/.test(txt)) throw new Error('не вижу «Открытых сделок 1»')
  await shot('11-dashboard-rep')
})

await step('уведомление руководству о новой заявке', async () => {
  await logout()
  await login('admin@e2e.local')
  await page.getByRole('button', { name: /Уведомления: 1 новых/ }).click()
  await page.getByText(/Новая заявка ОБ-/).waitFor()
})

await step('мобильная вёрстка: список клиентов без горизонтального скролла страницы', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(base + '/clients')
  await page.getByText('Шина Мастер').waitFor()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  if (overflow) throw new Error('страница шире экрана')
  await shot('12-clients-mobile')
})

await browser.close()
for (const p of procs) p.kill()
await db.end()
await admin.query(`drop database if exists ${dbName} with (force)`)
await admin.end()

const failed = results.filter((r) => r[0] === 'FAIL')
const relevantProblems = problems.filter((p) => !/Failed to load resource: the server responded with a status of (400|401|404|409)/.test(p))
console.log(`\nИтог: ${results.length - failed.length} из ${results.length} сценариев прошли.`)
if (relevantProblems.length) console.log('Ошибки в консоли/сети:\n' + [...new Set(relevantProblems)].slice(0, 20).join('\n'))
process.exit(failed.length || relevantProblems.length ? 1 : 0)
