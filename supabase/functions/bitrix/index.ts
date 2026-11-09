// Supabase Edge Function «bitrix»: заявки Sillan CRM → сделки Битрикс24 в воронках отделов.
// Заявки одного клиента в один отдел за один день — одна сделка (позиции списком и товарами).
//
// Секреты (Supabase → Edge Functions → Secrets):
//   BITRIX_WEBHOOK_URL    — входящий вебхук Битрикс24 с правом «CRM (crm)»
//                           (если не задан — берётся BITRIX_REPORT_WEBHOOK, если у него есть право crm);
//   SERVICE_ROLE_KEY      — только если Supabase не передаёт SUPABASE_SERVICE_ROLE_KEY сам.
// В настройках функции выключите «Verify JWT»: функция сама проверяет, кто её вызвал.
//
// Действия (POST JSON):
//   { action: 'sync', request_ids: [...] } — отправить сделки этих заявок (любой пользователь, кто видит заявки)
//   { action: 'sync_pending' }             — дослать всё неотправленное (руководство или расписание)
//   { action: 'test' }                     — проверить вебхук, получить воронки и поля сделки (администратор)

import { createClient } from 'npm:@supabase/supabase-js@2'

export type Kind = 'service' | 'parts' | 'equipment'

export interface DealsConfig {
  enabled?: boolean
  create_company?: boolean
  crm_url?: string
  kinds?: Partial<Record<Kind, { category_id?: string; assigned_ids?: string }>>
  fields?: { source?: string; source_value?: string; city?: string; need?: string; count?: string; whatsapp?: string }
}

export interface DealPayload {
  id: string
  kind: Kind
  deal_day: string
  bitrix_deal_id: string | null
  bitrix_company_id: string | null
  bitrix_contact_id: string | null
  bitrix_assigned_id: string | null
  prev_assigned_id: string | null
  kind_created: number
  location: { id: string; name: string; city: string | null; address: string | null; phones: string[]; legal_name: string | null; bin: string | null }
  contacts: { full_name: string | null; position: string | null; phone: string | null; whatsapp: string | null; email: string | null; decision_maker: boolean }[]
  requests: {
    id: string; number: string; item_name: string; brand: string | null; model: string | null; article: string | null
    quantity: number; budget: number | null; urgency: string; description: string | null; comment: string | null
    category: string | null; initiator: string | null
  }[]
}

export interface FieldMeta { type: string; isMultiple?: boolean; title?: string; listLabel?: string; formLabel?: string; items?: { ID: string; VALUE: string }[] }

export const KIND_TITLE: Record<Kind, string> = { service: 'Сервис', parts: 'Запчасти', equipment: 'Продажа оборудования' }
const URGENCY: Record<string, string> = { low: 'низкая', normal: 'обычная', high: 'высокая', urgent: 'срочно' }
const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ₸`
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()

/** Название позиции: «Подъёмник · Sillan PL-4.0 · арт. 123 × 2» */
export function positionName(r: DealPayload['requests'][number]) {
  const extra = [[r.brand, r.model].filter(Boolean).join(' '), r.article && `арт. ${r.article}`].filter(Boolean).join(' · ')
  return `${r.item_name}${extra ? ` · ${extra}` : ''}`
}

/** Ответственный: прежний менеджер клиента в этом отделе, иначе следующий по очереди */
export function pickAssigned(p: DealPayload, cfg: DealsConfig): string | null {
  if (p.bitrix_assigned_id) return p.bitrix_assigned_id
  const ids = String(cfg.kinds?.[p.kind]?.assigned_ids ?? '').split(/[\s,;]+/).filter((x) => /^\d+$/.test(x))
  if (!ids.length) return null
  if (p.prev_assigned_id && ids.includes(p.prev_assigned_id)) return p.prev_assigned_id
  return ids[p.kind_created % ids.length]
}

/** Значение для поля сделки: для списка — ID пункта по тексту, иначе как есть */
export function fieldValue(meta: FieldMeta | undefined, value: string | number | null | undefined): unknown {
  if (value === null || value === undefined || value === '') return undefined
  if (!meta) return value
  if (meta.type === 'enumeration') {
    const v = norm(String(value))
    const item = meta.items?.find((i) => norm(i.VALUE) === v || i.ID === String(value))
    if (!item) return undefined
    return meta.isMultiple ? [item.ID] : item.ID
  }
  if (meta.type === 'integer' || meta.type === 'double') return Number(value)
  return meta.isMultiple ? [String(value)] : String(value)
}

/** Найти поле сделки по названию (для автонастройки) */
export function findField(fields: Record<string, FieldMeta>, ...names: string[]): string {
  const wanted = names.map(norm)
  for (const [code, f] of Object.entries(fields)) {
    if (!code.startsWith('UF_')) continue
    const labels = [f.listLabel, f.formLabel, f.title].filter(Boolean).map((x) => norm(String(x)))
    if (labels.some((l) => wanted.includes(l))) return code
  }
  return ''
}

/** Поля сделки Битрикс24 */
export function buildDealFields(p: DealPayload, cfg: DealsConfig, meta: Record<string, FieldMeta>, ids: { company?: string | null; contact?: string | null; assigned?: string | null; source?: string | null }, isNew: boolean) {
  const loc = p.location
  const reqs = p.requests
  const kind = KIND_TITLE[p.kind]
  const total = reqs.reduce((s, r) => s + (Number(r.budget) || 0), 0)
  const reps = [...new Set(reqs.map((r) => r.initiator).filter(Boolean))].join(', ') || '—'
  const contact = p.contacts[0]
  const address = [loc.city, loc.address].filter(Boolean).join(', ')
  const crmUrl = (cfg.crm_url ?? '').replace(/\/+$/, '')
  const lines: string[] = [
    `${kind} — заявки из Sillan CRM (${reqs.map((r) => r.number).join(', ')})`,
    `Торговый представитель: ${reps}`,
    '',
    `Клиент: ${loc.name}${loc.legal_name ? ` (${loc.legal_name}${loc.bin ? `, БИН ${loc.bin}` : ''})` : ''}`,
    address && `Адрес: ${address}`,
    loc.phones?.length ? `Телефоны точки: ${loc.phones.join(', ')}` : '',
    contact && `ЛПР / контакт: ${[contact.full_name, contact.position, contact.phone].filter(Boolean).join(', ')}`,
    '',
    'Позиции:',
    ...reqs.map((r, i) => {
      const parts = [
        `${i + 1}. ${positionName(r)} — ${r.quantity} шт.`,
        r.category && `категория: ${r.category}`,
        r.budget ? `бюджет ${money(Number(r.budget))}` : '',
        r.urgency && r.urgency !== 'normal' ? `срочность: ${URGENCY[r.urgency] ?? r.urgency}` : '',
      ].filter(Boolean)
      const more = [r.description, r.comment].filter(Boolean).join('. ')
      return parts.join(', ') + (more ? `\n   ${more}` : '') + (crmUrl ? `\n   ${crmUrl}/requests/${r.id}` : '')
    }),
    crmUrl ? `\nКлиент в CRM: ${crmUrl}/clients/${loc.id}` : '',
  ].filter((x): x is string => typeof x === 'string')

  const f: Record<string, unknown> = {
    TITLE: `${kind}: ${loc.name} — ${reqs.length === 1 ? positionName(reqs[0]) : `${reqs.length} позиции`}`,
    COMMENTS: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    OPPORTUNITY: total,
    CURRENCY_ID: 'KZT',
    SOURCE_DESCRIPTION: `Торговый представитель: ${reps} (Sillan CRM)`,
  }
  if (isNew) {
    f.OPENED = 'Y'
    if (ids.source) f.SOURCE_ID = ids.source
    const cat = cfg.kinds?.[p.kind]?.category_id
    if (cat !== undefined && cat !== '') f.CATEGORY_ID = Number(cat)
    if (ids.assigned) f.ASSIGNED_BY_ID = Number(ids.assigned)
  }
  if (ids.company) f.COMPANY_ID = Number(ids.company)
  if (ids.contact) f.CONTACT_IDS = [Number(ids.contact)]

  const uf = cfg.fields ?? {}
  const set = (code: string | undefined, value: string | number | null | undefined) => {
    if (!code) return
    const v = fieldValue(meta[code], value)
    if (v !== undefined) f[code] = v
  }
  if (isNew) set(uf.source, uf.source_value || 'Торговый представитель')
  set(uf.city, loc.city)
  set(uf.need, reqs.map((r) => `${positionName(r)} × ${r.quantity}`).join('; '))
  set(uf.count, reqs.length)
  set(uf.whatsapp, contact?.whatsapp || contact?.phone || loc.phones?.[0])
  return f
}

export function productRows(p: DealPayload) {
  return p.requests.map((r) => ({
    PRODUCT_NAME: positionName(r),
    QUANTITY: r.quantity,
    PRICE: r.budget ? Math.round((Number(r.budget) / r.quantity) * 100) / 100 : 0,
    MEASURE_CODE: 796, // шт
  }))
}

export type Call = (method: string, params: Record<string, unknown>) => Promise<any>

/** Вызов REST Битрикс24 через вебхук */
export function bitrixCaller(webhook: string, fetchFn: typeof fetch = fetch): Call {
  const base = webhook.replace(/\/+$/, '') + '/'
  return async (method, params) => {
    const res = await fetchFn(base + method + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
    let data: { result?: unknown; error?: string; error_description?: string } = {}
    try { data = await res.json() } catch { /* не JSON */ }
    if (!res.ok || data.error) {
      const msg = data.error_description || data.error || `HTTP ${res.status}`
      if (/higher privileges|insufficient_scope|ACCESS_DENIED/i.test(msg + (data.error ?? ''))) {
        throw new Error('У вебхука нет права «CRM (crm)»: Битрикс24 → Разработчикам → Интеграции → вебхук → добавьте право CRM → Сохранить')
      }
      throw new Error(`Битрикс24 (${method}): ${msg}`)
    }
    return data.result
  }
}

async function findByPhone(call: Call, type: 'COMPANY' | 'CONTACT', phones: string[]): Promise<string | null> {
  if (!phones.length) return null
  try {
    const r = await call('crm.duplicate.findbycomm', { type: 'PHONE', values: phones.slice(0, 20), entity_type: type })
    const ids = r && !Array.isArray(r) ? r[type] : null
    return ids?.length ? String(ids[0]) : null
  } catch {
    return null
  }
}

/** Компания и контакт в Битрикс24: прежние, найденные по телефону/названию или новые */
export async function ensureCompanyContact(call: Call, p: DealPayload, cfg: DealsConfig, assigned: string | null) {
  let company = p.bitrix_company_id
  let contact = p.bitrix_contact_id
  if (cfg.create_company === false) return { company, contact }
  const loc = p.location
  const title = loc.legal_name || loc.name
  if (!company) {
    company = await findByPhone(call, 'COMPANY', loc.phones ?? [])
    if (!company) {
      const found = await call('crm.company.list', { filter: { TITLE: title }, select: ['ID'] })
      if (Array.isArray(found) && found.length) company = String(found[0].ID)
    }
    if (!company) {
      const fields: Record<string, unknown> = {
        TITLE: title,
        COMPANY_TYPE: 'CUSTOMER',
        ADDRESS: [loc.city, loc.address].filter(Boolean).join(', ') || undefined,
        COMMENTS: `Из Sillan CRM: ${loc.name}${loc.bin ? `, БИН ${loc.bin}` : ''}`,
        OPENED: 'Y',
      }
      if (loc.phones?.length) fields.PHONE = loc.phones.map((v) => ({ VALUE: v, VALUE_TYPE: 'WORK' }))
      if (assigned) fields.ASSIGNED_BY_ID = Number(assigned)
      company = String(await call('crm.company.add', { fields }))
    }
  }
  const c = p.contacts.find((x) => x.full_name || x.phone)
  if (!contact && c) {
    contact = await findByPhone(call, 'CONTACT', [c.phone, c.whatsapp].filter((x): x is string => !!x))
    if (!contact) {
      const fields: Record<string, unknown> = {
        NAME: c.full_name || 'Контакт', POST: c.position || undefined, OPENED: 'Y',
        COMMENTS: `Из Sillan CRM, ${loc.name}`,
      }
      if (c.phone) fields.PHONE = [{ VALUE: c.phone, VALUE_TYPE: 'WORK' }]
      if (c.email) fields.EMAIL = [{ VALUE: c.email, VALUE_TYPE: 'WORK' }]
      if (company) fields.COMPANY_ID = Number(company)
      if (assigned) fields.ASSIGNED_BY_ID = Number(assigned)
      contact = String(await call('crm.contact.add', { fields }))
    }
  }
  return { company, contact }
}

/** Стандартное поле «Источник»: значение «Торговый представитель» (найти по названию, иначе добавить) */
export async function resolveSource(call: Call, name = 'Торговый представитель'): Promise<string | null> {
  try {
    const list = (await call('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } })) as { STATUS_ID: string; NAME: string }[]
    const found = (list ?? []).find((x) => norm(x.NAME) === norm(name))
    if (found) return found.STATUS_ID
    await call('crm.status.add', { fields: { ENTITY_ID: 'SOURCE', STATUS_ID: 'SILLAN_REP', NAME: name, SORT: 500 } })
    return 'SILLAN_REP'
  } catch {
    return null // нет прав на справочник — остаётся «Источник Маркетинг» и описание источника
  }
}

/** Создать или обновить сделку. Возвращает ID в Битриксе. */
export async function pushDeal(call: Call, p: DealPayload, cfg: DealsConfig, meta: Record<string, FieldMeta>, sourceId: string | null = null) {
  if (!p.requests.length) return { deal: p.bitrix_deal_id, company: p.bitrix_company_id, contact: p.bitrix_contact_id, assigned: p.bitrix_assigned_id, warning: null as string | null }
  const assigned = pickAssigned(p, cfg)
  const { company, contact } = await ensureCompanyContact(call, p, cfg, assigned)
  const isNew = !p.bitrix_deal_id
  const fields = buildDealFields(p, cfg, meta, { company, contact, assigned, source: sourceId }, isNew)
  let deal = p.bitrix_deal_id
  if (isNew) {
    deal = String(await call('crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }))
  } else {
    await call('crm.deal.update', { id: Number(deal), fields })
  }
  let warning: string | null = null
  try {
    await call('crm.deal.productrows.set', { id: Number(deal), rows: productRows(p) })
  } catch (e) {
    warning = 'Товары не добавлены: ' + (e instanceof Error ? e.message : String(e)) // позиции есть в комментарии
  }
  return { deal, company, contact, assigned, warning }
}

/** Для настроек: воронки и поля сделки, автоподбор полей формы по названиям */
export async function describePortal(call: Call) {
  const [profile, cats, fields] = await Promise.all([
    call('profile', {}).catch(() => null),
    call('crm.category.list', { entityTypeId: 2 }).catch(() => null),
    call('crm.deal.fields', {}),
  ])
  let categories: { id: string; name: string }[] = (cats?.categories ?? []).map((c: any) => ({ id: String(c.id), name: String(c.name) }))
  if (!categories.length) {
    const old = await call('crm.dealcategory.list', {}).catch(() => [])
    categories = [{ id: '0', name: 'Общая' }, ...(old ?? []).map((c: any) => ({ id: String(c.ID), name: String(c.NAME) }))]
  }
  const meta = fields as Record<string, FieldMeta>
  const userFields = Object.entries(meta).filter(([k]) => k.startsWith('UF_')).map(([code, f]) => ({
    code, title: String(f.listLabel || f.formLabel || f.title || code), type: f.type,
    items: f.items?.map((i) => ({ id: i.ID, value: i.VALUE })) ?? [],
  }))
  const source = findField(meta, 'Источник Маркетинг', 'Источник маркетинг', 'Источник')
  const guess = {
    source,
    source_value: (meta[source]?.items ?? []).find((i) => norm(i.VALUE) === 'торговый представитель')?.VALUE ?? '',
    city: findField(meta, 'Город'),
    need: findField(meta, 'Потребность в товаре', 'Потребность'),
    count: findField(meta, 'Количество товарных позиций'),
    whatsapp: findField(meta, 'Whatsapp', 'WhatsApp', 'Ватсап'),
  }
  return {
    user: profile ? { id: String(profile.ID), name: [profile.NAME, profile.LAST_NAME].filter(Boolean).join(' ') } : null,
    categories, fields: userFields, guess,
  }
}

// ----------------------------------------------------------------------------------------------
// HTTP-обработчик (только в Supabase Edge Runtime)
// ----------------------------------------------------------------------------------------------
declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void } | undefined

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-report-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

if (typeof Deno !== 'undefined') {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405)
    const url = Deno.env.get('SUPABASE_URL')
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('CRM_SECRET_KEY')
    if (!url || !service) return json({ error: 'В функции нет секретного ключа: Supabase → Edge Functions → Secrets → SERVICE_ROLE_KEY' }, 500)
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })

    let body: Record<string, any> = {}
    try { body = await req.json() } catch { /* пусто */ }
    const action = String(body.action ?? 'sync')

    // кто вызывает
    let role = 'cron'
    let uid = ''
    const token = req.headers.get('x-report-token')
    if (token) {
      const { data: ok } = await admin.rpc('daily_report_check_token', { p_token: token })
      if (!ok) return json({ error: 'Неверный токен расписания' }, 403)
      if (action !== 'sync_pending') return json({ error: 'Расписанию доступна только досылка' }, 403)
    } else {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
      const { data: u, error } = await admin.auth.getUser(jwt)
      if (!jwt || error || !u?.user) return json({ error: 'Сессия недействительна — войдите в CRM заново' }, 401)
      const { data: me } = await admin.from('profiles').select('role, is_active').eq('id', u.user.id).maybeSingle()
      if (!me?.is_active) return json({ error: 'Учётная запись отключена' }, 403)
      role = me.role
      uid = u.user.id
      if (action === 'test' && role !== 'admin') return json({ error: 'Проверяет администратор' }, 403)
      if (action === 'sync_pending' && !['admin', 'head'].includes(role)) return json({ error: 'Досылает руководитель или администратор' }, 403)
    }

    const webhook = (Deno.env.get('BITRIX_WEBHOOK_URL') || Deno.env.get('BITRIX_REPORT_WEBHOOK') || '').trim()
    if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/?$/.test(webhook)) {
      return json({ disabled: true, error: 'Не задан вебхук Битрикс24: Supabase → Edge Functions → Secrets → BITRIX_WEBHOOK_URL' }, action === 'sync' ? 200 : 400)
    }
    const call = bitrixCaller(webhook)

    if (action === 'test') {
      try { return json({ ...(await describePortal(call)), portal_url: new URL(webhook).origin }) } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502) }
    }

    const { data: setting } = await admin.from('app_settings').select('value').eq('key', 'bitrix_deals').maybeSingle()
    const cfg = (setting?.value ?? {}) as DealsConfig
    if (!cfg.enabled) return json({ disabled: true })

    // отправляются только отделы, для которых выбрана воронка
    const kinds = (Object.keys(KIND_TITLE) as Kind[]).filter((k) => String(cfg.kinds?.[k]?.category_id ?? '') !== '')
    if (!kinds.length) return json({ error: 'В настройках не выбрана ни одна воронка' }, 400)

    // какие сделки
    let ids: string[] = []
    if (action === 'sync') {
      const requested = (Array.isArray(body.request_ids) ? body.request_ids : []).filter((x: unknown) => typeof x === 'string').slice(0, 50)
      if (!requested.length) return json({ error: 'Не указаны заявки' }, 400)
      // торговый отправляет свои заявки и заявки своих клиентов; руководство — любые
      const { data: rows } = await admin.from('requests').select('id, initiator_id, location:locations(manager_id)').in('id', requested)
      const allowed = ((rows ?? []) as unknown as { id: string; initiator_id: string; location: { manager_id: string | null } | null }[])
        .filter((q) => ['admin', 'head'].includes(role) || q.initiator_id === uid || q.location?.manager_id === uid)
        .map((q) => q.id)
      if (!allowed.length) return json({ error: 'Заявки не найдены' }, 404)
      const { data } = await admin.rpc('bitrix_deals_to_sync', { p_request_ids: allowed, p_limit: 50 })
      const { data: rows2 } = await admin.from('bitrix_deals').select('id, kind').in('id', data ?? [])
      const skipped = (rows2 ?? []).filter((d: { kind: Kind }) => !kinds.includes(d.kind))
      if (skipped.length && skipped.length === (rows2 ?? []).length) {
        return json({ error: `Для отдела «${KIND_TITLE[skipped[0].kind as Kind]}» не выбрана воронка в настройках — заявка ждёт в CRM` }, 400)
      }
      ids = (rows2 ?? []).filter((d: { kind: Kind }) => kinds.includes(d.kind)).map((d: { id: string }) => d.id)
    } else if (action === 'sync_pending') {
      const { data } = await admin.from('bitrix_deals').select('id').neq('status', 'sent').lt('attempts', 20)
        .in('kind', kinds).order('deal_day').order('created_at').limit(25)
      ids = (data ?? []).map((d: { id: string }) => d.id)
    } else {
      return json({ error: 'Неизвестное действие' }, 400)
    }

    let meta: Record<string, FieldMeta> = {}
    try { meta = await call('crm.deal.fields', {}) } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502) }

    const sourceId = ids.length ? await resolveSource(call, cfg.fields?.source_value || 'Торговый представитель') : null
    const result = { sent: 0, errors: [] as string[], warnings: [] as string[], deals: [] as { id: string; bitrix_deal_id: string | null }[] }
    for (const id of ids) {
      const { data: claimed } = await admin.rpc('bitrix_claim_deal', { p_id: id })
      if (!claimed) continue // уже отправляется
      const { data: p } = await admin.rpc('bitrix_deal_payload', { p_id: id })
      const payload = p as DealPayload
      try {
        const r = await pushDeal(call, payload, cfg, meta, sourceId)
        await admin.rpc('bitrix_finish_deal', {
          p_id: id, p_claimed: claimed, p_ok: true, p_error: null, p_deal_id: r.deal, p_company_id: r.company,
          p_contact_id: r.contact, p_request_ids: payload.requests.map((q) => q.id), p_assigned_id: r.assigned,
        })
        if (r.warning) result.warnings.push(r.warning)
        result.sent++
        result.deals.push({ id, bitrix_deal_id: r.deal })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await admin.rpc('bitrix_finish_deal', {
          p_id: id, p_claimed: claimed, p_ok: false, p_error: msg, p_deal_id: null, p_company_id: null,
          p_contact_id: null, p_request_ids: [], p_assigned_id: null,
        })
        result.errors.push(`${payload?.location?.name ?? id}: ${msg}`)
      }
    }
    const { count } = await admin.from('bitrix_deals').select('id', { count: 'exact', head: true }).neq('status', 'sent').lt('attempts', 20).in('kind', kinds)
    return json({ ...result, left: count ?? null })
  })
}
