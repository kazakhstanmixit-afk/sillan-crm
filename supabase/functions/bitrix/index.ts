// Supabase Edge Function «bitrix»: отправляет заявки CRM в Битрикс24 (лид или сделка) через входящий вебхук.
//
// Секреты (Supabase → Edge Functions → Secrets):
//   BITRIX_WEBHOOK_URL — адрес входящего вебхука, например https://company.bitrix24.kz/rest/1/abc123/
//   SERVICE_ROLE_KEY   — Secret key проекта (если Supabase не передаёт SUPABASE_SERVICE_ROLE_KEY сам)
// В настройках функции выключите «Verify JWT»: функция сама проверяет пользователя.
//
// Действия (POST JSON):
//   { action: 'send', request_ids: [...] }  — отправить заявки (уже отправленные пропускаются)
//   { action: 'send_pending' }               — отправить все неотправленные (только руководство)
//   { action: 'test' }                       — проверить вебхук и источник (только администратор)

export interface BitrixConfig {
  enabled: boolean
  entity: 'lead' | 'deal'
  source_name: string
  source_id: string
  kinds: Record<string, { assigned_by_id?: string; category_id?: string }>
}

export interface RequestData {
  id: string
  number: string
  kind: 'service' | 'parts' | 'equipment'
  item_name: string
  brand: string | null
  model: string | null
  article: string | null
  quantity: number
  budget: number | null
  urgency: string
  description: string | null
  comment: string | null
  category: string | null
  location: { name: string; city: string | null; address: string | null; phones: string[]; legal_name: string | null } | null
  contact: { full_name: string | null; position: string | null; phone: string | null } | null
  initiator: string | null
}

const KIND = { service: 'Сервис', parts: 'Запчасти', equipment: 'Продажа оборудования' } as const
const URGENCY: Record<string, string> = { low: 'низкая', normal: 'обычная', high: 'высокая', urgent: 'срочно' }

/** Поля лида/сделки для Битрикс24 */
export function buildFields(r: RequestData, cfg: BitrixConfig, sourceId: string, crmUrl: string) {
  const loc = r.location
  const address = [loc?.city, loc?.address].filter(Boolean).join(', ')
  const lines = [
    `Заявка ${r.number} из Sillan CRM (${KIND[r.kind]})`,
    `Клиент: ${loc?.name ?? '—'}${loc?.legal_name ? ` (${loc.legal_name})` : ''}`,
    address && `Адрес: ${address}`,
    r.contact && `Контакт: ${[r.contact.full_name, r.contact.position, r.contact.phone].filter(Boolean).join(', ')}`,
    loc?.phones?.length && `Телефоны точки: ${loc.phones.join(', ')}`,
    `${r.kind === 'service' ? 'Оборудование' : r.kind === 'parts' ? 'Запчасть' : 'Хотят купить'}: ${r.item_name}`,
    r.category && `Категория: ${r.category}`,
    r.brand && `Бренд: ${r.brand}`,
    r.model && `Модель: ${r.model}`,
    r.article && `Артикул: ${r.article}`,
    `Количество: ${r.quantity}`,
    r.budget && `Бюджет: ${Number(r.budget).toLocaleString('ru-RU')} ₸`,
    `Срочность: ${URGENCY[r.urgency] ?? r.urgency}`,
    r.description && `${r.kind === 'service' ? 'Что случилось' : 'Описание'}: ${r.description}`,
    r.comment && `Комментарий: ${r.comment}`,
    `Торговый представитель: ${r.initiator ?? '—'}`,
    crmUrl && `Открыть в CRM: ${crmUrl}/requests/${r.id}`,
  ].filter(Boolean) as string[]

  const phones = [r.contact?.phone, ...(loc?.phones ?? [])].filter((p, i, a): p is string => !!p && a.indexOf(p) === i)
  const k = cfg.kinds?.[r.kind] ?? {}
  const fields: Record<string, unknown> = {
    TITLE: `${KIND[r.kind]}: ${r.item_name} — ${loc?.name ?? 'клиент'}`,
    SOURCE_ID: sourceId,
    SOURCE_DESCRIPTION: `Торговый представитель: ${r.initiator ?? '—'} (Sillan CRM, ${r.number})`,
    COMMENTS: lines.join('\n'),
    OPENED: 'Y',
  }
  if (r.budget) { fields.OPPORTUNITY = Number(r.budget); fields.CURRENCY_ID = 'KZT' }
  if (k.assigned_by_id) fields.ASSIGNED_BY_ID = Number(k.assigned_by_id)
  if (cfg.entity === 'deal') {
    if (k.category_id !== undefined && k.category_id !== '') fields.CATEGORY_ID = Number(k.category_id)
  } else {
    fields.COMPANY_TITLE = loc?.legal_name || loc?.name || ''
    if (r.contact?.full_name) fields.NAME = r.contact.full_name
    if (r.contact?.position) fields.POST = r.contact.position
    if (address) fields.ADDRESS = address
    if (phones.length) fields.PHONE = phones.map((p) => ({ VALUE: p, VALUE_TYPE: 'WORK' }))
  }
  return fields
}

type Call = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** Вызов REST Битрикс24 через вебхук */
export function bitrixCaller(webhook: string, fetchFn: typeof fetch = fetch): Call {
  const base = webhook.replace(/\/+$/, '') + '/'
  return async (method, params) => {
    const res = await fetchFn(base + method + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
    let data: { result?: unknown; error?: string; error_description?: string } = {}
    try { data = await res.json() } catch { /* ответ не JSON */ }
    if (!res.ok || data.error) {
      const msg = data.error_description || data.error || `HTTP ${res.status}`
      throw new Error(res.status === 401 || /INVALID_CREDENTIALS|insufficient/i.test(msg) ? `Битрикс отклонил вебхук: ${msg}` : `Битрикс: ${msg}`)
    }
    return data.result
  }
}

/** Код источника «Торговый представитель»: из настроек, иначе найти по названию, иначе создать */
export async function resolveSource(call: Call, cfg: BitrixConfig): Promise<string> {
  if (cfg.source_id) return cfg.source_id
  const name = (cfg.source_name || 'Торговый представитель').trim()
  const list = (await call('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } })) as { STATUS_ID: string; NAME: string }[]
  const found = list?.find((s) => s.NAME.trim().toLowerCase() === name.toLowerCase())
  if (found) return found.STATUS_ID
  try {
    await call('crm.status.add', { fields: { ENTITY_ID: 'SOURCE', STATUS_ID: 'SILLAN_REP', NAME: name, SORT: 500 } })
    return 'SILLAN_REP'
  } catch {
    return 'OTHER' // нет прав создавать источники — «Другое», название будет в описании источника
  }
}

/** Отправить одну заявку: создать лид или сделку */
export async function pushRequest(call: Call, r: RequestData, cfg: BitrixConfig, sourceId: string, crmUrl: string) {
  const method = cfg.entity === 'deal' ? 'crm.deal.add' : 'crm.lead.add'
  const id = await call(method, { fields: buildFields(r, cfg, sourceId, crmUrl), params: { REGISTER_SONET_EVENT: 'Y' } })
  return { entity: cfg.entity, id: String(id) }
}

// ----------------------------------------------------------------------------------------------
// HTTP-обработчик (только в Supabase Edge Runtime)
// ----------------------------------------------------------------------------------------------
declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void } | undefined

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

if (typeof Deno !== 'undefined') {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405)
    const url = Deno.env.get('SUPABASE_URL')
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY')
    const webhook = Deno.env.get('BITRIX_WEBHOOK_URL')
    if (!url || !service) return json({ error: 'В функции нет секретного ключа: добавьте SERVICE_ROLE_KEY в Edge Functions → Secrets' }, 500)

    const lib = 'npm:@supabase/supabase-js@2'
    const { createClient } = await import(/* @vite-ignore */ lib)
    const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: u } = await db.auth.getUser(jwt)
    if (!u?.user) return json({ error: 'Сессия недействительна — войдите в CRM заново' }, 401)
    const { data: me } = await db.from('profiles').select('id, role, is_active').eq('id', u.user.id).maybeSingle()
    if (!me?.is_active) return json({ error: 'Учётная запись не активна' }, 403)
    const boss = me.role === 'admin' || me.role === 'head'

    let body: { action?: string; request_ids?: string[] } = {}
    try { body = await req.json() } catch { /* пустое тело */ }
    const { data: setting } = await db.from('app_settings').select('value').eq('key', 'bitrix').maybeSingle()
    const cfg = { enabled: true, entity: 'lead', source_name: 'Торговый представитель', source_id: '', kinds: {}, ...(setting?.value ?? {}) } as BitrixConfig
    if (!webhook) return json({ disabled: true, error: 'Интеграция не настроена: добавьте секрет BITRIX_WEBHOOK_URL' }, body.action === 'test' ? 400 : 200)
    if (!cfg.enabled) return json({ disabled: true })
    const call = bitrixCaller(webhook)

    if (body.action === 'test') {
      if (me.role !== 'admin') return json({ error: 'Только администратор' }, 403)
      try {
        const source = await resolveSource(call, cfg)
        const sources = (await call('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } })) as { STATUS_ID: string; NAME: string }[]
        let categories: { id: number; name: string }[] = []
        try {
          const c = (await call('crm.category.list', { entityTypeId: 2 })) as { categories?: { id: number; name: string }[] }
          categories = c?.categories ?? []
        } catch { /* старый портал — без воронок */ }
        return json({ ok: true, source_id: source, sources: sources.map((s) => ({ id: s.STATUS_ID, name: s.NAME })), categories })
      } catch (e) {
        return json({ error: (e as Error).message }, 400)
      }
    }

    let q = db.from('requests').select(`id, number, kind, item_name, brand, model, article, quantity, budget, urgency, description, comment,
      initiator_id, assignee_id, bitrix_status, category:equipment_categories(name),
      location:locations(name, city, district, confirmed_address, source_address, phones, manager_id, company:companies(legal_name)),
      contact:contacts(full_name, position, phone), initiator:profiles!requests_initiator_id_fkey(full_name)`)
    if (body.action === 'send_pending') {
      if (!boss) return json({ error: 'Только руководство' }, 403)
      q = q.neq('bitrix_status', 'sent').order('created_at').limit(50)
    } else {
      const ids = (body.request_ids ?? []).slice(0, 20)
      if (!ids.length) return json({ error: 'Не указаны заявки' }, 400)
      q = q.in('id', ids)
    }
    const { data: rows, error } = await q
    if (error) return json({ error: error.message }, 500)

    const crmUrl = (req.headers.get('origin') ?? '').replace(/\/+$/, '')
    let sourceId = ''
    const results: { id: string; number: string; ok: boolean; bitrix_id?: string; error?: string }[] = []
    for (const r of rows ?? []) {
      const allowed = boss || r.initiator_id === me.id || r.assignee_id === me.id || r.location?.manager_id === me.id
      if (!allowed) { results.push({ id: r.id, number: r.number, ok: false, error: 'Нет доступа' }); continue }
      if (r.bitrix_status === 'sent') { results.push({ id: r.id, number: r.number, ok: true }); continue }
      try {
        if (!sourceId) sourceId = await resolveSource(call, cfg)
        const data: RequestData = {
          ...r, category: r.category?.name ?? null, initiator: r.initiator?.full_name ?? null,
          location: r.location ? { name: r.location.name, city: r.location.city,
            address: [r.location.district, r.location.confirmed_address ?? r.location.source_address].filter(Boolean).join(', ') || null,
            phones: r.location.phones ?? [], legal_name: r.location.company?.legal_name ?? null } : null,
        }
        const res = await pushRequest(call, data, cfg, sourceId, crmUrl)
        await db.from('requests').update({ bitrix_status: 'sent', bitrix_entity: res.entity, bitrix_id: res.id, bitrix_error: null, bitrix_sent_at: new Date().toISOString() }).eq('id', r.id)
        results.push({ id: r.id, number: r.number, ok: true, bitrix_id: res.id })
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500)
        await db.from('requests').update({ bitrix_status: 'error', bitrix_error: msg }).eq('id', r.id)
        results.push({ id: r.id, number: r.number, ok: false, error: msg })
      }
    }
    return json({ entity: cfg.entity, results })
  })
}
