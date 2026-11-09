import { describe, expect, it } from 'vitest'
import { bitrixCaller, buildDealFields, findDuplicates, describePortal, fieldValue, pickAssigned, pushDeal, resolveSource, type Call, type DealPayload, type DealsConfig, type FieldMeta } from '../../supabase/functions/bitrix/index'

const META: Record<string, FieldMeta> = {
  UF_CRM_SRC: { type: 'enumeration', listLabel: 'Источник Маркетинг', items: [{ ID: '101', VALUE: 'fb insta' }, { ID: '177', VALUE: 'Торговый представитель' }] },
  UF_CRM_CITY: { type: 'string', listLabel: 'Город' },
  UF_CRM_NEED: { type: 'string', listLabel: 'Потребность в товаре' },
  UF_CRM_CNT: { type: 'enumeration', listLabel: 'Количество товарных позиций', items: [{ ID: '1', VALUE: '1' }, { ID: '2', VALUE: '2' }, { ID: '3', VALUE: '3' }] },
  UF_CRM_WA: { type: 'string', listLabel: 'Whatsapp' },
  TITLE: { type: 'string', title: 'Название' },
}
const CFG: DealsConfig = {
  enabled: true, create_company: true, crm_url: 'https://crm.example',
  kinds: { equipment: { category_id: '46', assigned_ids: '15, 22' }, parts: { category_id: '48', assigned_ids: '31' } },
  fields: { source: 'UF_CRM_SRC', city: 'UF_CRM_CITY', need: 'UF_CRM_NEED', count: 'UF_CRM_CNT', whatsapp: 'UF_CRM_WA' },
}
const req = (n: string, item: string, extra: Partial<DealPayload['requests'][number]> = {}) => ({
  id: 'r' + n, number: n, item_name: item, brand: null, model: null, article: null, quantity: 1, budget: null,
  urgency: 'normal', description: null, comment: null, category: null, initiator: 'Талгат Исмаил', ...extra,
})
const payload = (over: Partial<DealPayload> = {}): DealPayload => ({
  id: 'd1', kind: 'equipment', deal_day: '2026-11-06', bitrix_deal_id: null, bitrix_company_id: null, bitrix_contact_id: null,
  bitrix_assigned_id: null, prev_assigned_id: null, kind_created: 0,
  location: { id: 'L1', name: 'Car wash, автомойка', city: 'Астана', address: 'ул. Ауэзова 1', phones: ['+77011112233'], legal_name: null, bin: null },
  contacts: [{ full_name: 'Ерлан', position: 'Владелец', phone: '+77015554433', whatsapp: null, email: null, decision_maker: true }],
  requests: [
    req('ОБ-000023', 'Двухстоечный подъёмник', { brand: 'Sillan', model: 'PL-4.0-2DA', budget: 1200000 }),
    req('ОБ-000024', 'Стойка гидравлическая'),
    req('ОБ-000025', 'Кран для извлечения двигателя', { quantity: 2 }),
  ],
  ...over,
})

function fakeBitrix(existing: { companyByPhone?: string } = {}) {
  const calls: { method: string; params: any }[] = []
  let next = 500
  const call: Call = async (method, params) => {
    calls.push({ method, params })
    if (method === 'crm.duplicate.findbycomm') return params.entity_type === 'COMPANY' && existing.companyByPhone ? { COMPANY: [existing.companyByPhone] } : []
    if (method.endsWith('.list')) return []
    if (method.endsWith('.add')) return next++
    return true
  }
  return { call, calls }
}

describe('Сделки Битрикс24 из заявок', () => {
  it('три заявки одного клиента в один отдел — одна сделка с позициями, воронка, источник и поля формы', () => {
    const f = buildDealFields(payload(), CFG, META, { company: '7', contact: '8', assigned: '15', source: 'UC_7' }, true)
    expect(f.SOURCE_ID).toBe('UC_7')
    expect(f.TITLE).toBe('Продажа оборудования: Car wash, автомойка — 3 позиции')
    expect(f.CATEGORY_ID).toBe(46)
    expect(f.ASSIGNED_BY_ID).toBe(15)
    expect(f.COMPANY_ID).toBe(7)
    expect(f.CONTACT_IDS).toEqual([8])
    expect(f.OPPORTUNITY).toBe(1200000)
    expect(f.UF_CRM_SRC).toBe('177')
    expect(f.UF_CRM_CITY).toBe('Астана')
    expect(f.UF_CRM_CNT).toBe('3')
    expect(f.UF_CRM_WA).toBe('+77015554433')
    expect(f.UF_CRM_NEED).toBe('Двухстоечный подъёмник · Sillan PL-4.0-2DA × 1; Стойка гидравлическая × 1; Кран для извлечения двигателя × 2')
    expect(String(f.COMMENTS)).toContain('Торговый представитель: Талгат Исмаил')
    expect(String(f.COMMENTS)).toContain('1. Двухстоечный подъёмник · Sillan PL-4.0-2DA — 1 шт., бюджет 1 200 000 ₸')
    expect(String(f.COMMENTS)).toContain('https://crm.example/clients/L1')
  })

  it('при обновлении воронку, ответственного и источник не трогает', () => {
    const f = buildDealFields(payload({ bitrix_deal_id: '900' }), CFG, META, { company: '7', assigned: '15' }, false)
    expect(f).not.toHaveProperty('CATEGORY_ID')
    expect(f).not.toHaveProperty('ASSIGNED_BY_ID')
    expect(f).not.toHaveProperty('UF_CRM_SRC')
  })

  it('ответственный: по очереди; тот же клиент — тот же менеджер', () => {
    expect(pickAssigned(payload({ kind_created: 0 }), CFG)).toBe('15')
    expect(pickAssigned(payload({ kind_created: 1 }), CFG)).toBe('22')
    expect(pickAssigned(payload({ kind_created: 2 }), CFG)).toBe('15')
    expect(pickAssigned(payload({ kind_created: 1, prev_assigned_id: '15' }), CFG)).toBe('15')
    expect(pickAssigned(payload({ kind: 'service' }), CFG)).toBeNull()
  })

  it('значение списка — по тексту, неизвестное не отправляется', () => {
    expect(fieldValue(META.UF_CRM_SRC, 'торговый  представитель')).toBe('177')
    expect(fieldValue(META.UF_CRM_SRC, 'Нет такого')).toBeUndefined()
    expect(fieldValue({ type: 'enumeration', isMultiple: true, items: [{ ID: '5', VALUE: 'Да' }] }, 'да')).toEqual(['5'])
  })

  it('новая сделка: создаёт компанию и контакт, сделку и товары', async () => {
    const b = fakeBitrix()
    const r = await pushDeal(b.call, payload(), CFG, META)
    const m = b.calls.map((c) => c.method)
    expect(m).toContain('crm.company.add')
    expect(m).toContain('crm.contact.add')
    const add = b.calls.find((c) => c.method === 'crm.deal.add')!
    expect(add.params.fields.COMPANY_ID).toBe(r.company && Number(r.company))
    const rows = b.calls.find((c) => c.method === 'crm.deal.productrows.set')!
    expect(rows.params.rows).toHaveLength(3)
    expect(rows.params.rows[0]).toMatchObject({ PRICE: 1200000, QUANTITY: 1 })
    expect(r).toMatchObject({ assigned: '15', warning: null })
  })

  it('компания уже есть в Битриксе по телефону — новую не создаёт; повторная отправка обновляет сделку', async () => {
    const b = fakeBitrix({ companyByPhone: '42' })
    const r = await pushDeal(b.call, payload(), CFG, META)
    expect(r.company).toBe('42')
    expect(b.calls.some((c) => c.method === 'crm.company.add')).toBe(false)

    const b2 = fakeBitrix()
    await pushDeal(b2.call, payload({ bitrix_deal_id: '900', bitrix_company_id: '42', bitrix_contact_id: '43', bitrix_assigned_id: '22' }), CFG, META)
    const m = b2.calls.map((c) => c.method)
    expect(m).toEqual(['crm.deal.update', 'crm.deal.productrows.set'])
  })

  it('настройки: находит воронки и поля формы по названиям', async () => {
    const call: Call = async (method) => {
      if (method === 'profile') return { ID: '70', NAME: 'Нина', LAST_NAME: 'Васильева' }
      if (method === 'crm.category.list') return { categories: [{ id: 0, name: 'Общая' }, { id: 46, name: 'Отдел Продаж' }] }
      if (method === 'crm.deal.fields') return META
      return []
    }
    const d = await describePortal(call)
    expect(d.user).toEqual({ id: '70', name: 'Нина Васильева' })
    expect(d.categories).toEqual([{ id: '0', name: 'Общая' }, { id: '46', name: 'Отдел Продаж' }])
    expect(d.guess).toEqual({ source: 'UF_CRM_SRC', source_value: 'Торговый представитель', city: 'UF_CRM_CITY', need: 'UF_CRM_NEED', count: 'UF_CRM_CNT', whatsapp: 'UF_CRM_WA' })
  })

  it('стандартный «Источник»: находит «Торговый представитель», иначе добавляет', async () => {
    const found: Call = async (m) => m === 'crm.status.list' ? [{ STATUS_ID: 'WEB', NAME: 'Сайт' }, { STATUS_ID: 'UC_7', NAME: 'Торговый  представитель' }] : null
    expect(await resolveSource(found)).toBe('UC_7')
    const added: string[] = []
    const none: Call = async (m, p) => { if (m === 'crm.status.add') added.push((p as { fields: { NAME: string } }).fields.NAME); return m === 'crm.status.list' ? [] : 1 }
    expect(await resolveSource(none)).toBe('SILLAN_REP')
    expect(added).toEqual(['Торговый представитель'])
    const denied: Call = async () => { throw new Error('нет прав') }
    expect(await resolveSource(denied)).toBeNull()
  })

  it('номер сделки и компании запоминается сразу — при обрыве после создания дубля не будет', async () => {
    const saved: any[] = []
    const call: Call = async (m) => {
      if (m === 'crm.deal.productrows.set') throw new Error('оборвалось')
      if (m.endsWith('.add')) return m === 'crm.deal.add' ? 900 : 11
      return []
    }
    const r = await pushDeal(call, payload(), CFG, META, null, async (x) => { saved.push(x) })
    expect(saved).toEqual([{ company: '11', contact: '11', assigned: '15' }, { deal: '900' }])
    expect(r.warning).toContain('Товары не добавлены')
  })

  it('Битрикс не отвечает — понятная ошибка по таймауту', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
    })) as unknown as typeof fetch
    const call = bitrixCaller('https://b.example/rest/1/x/', hang, 50)
    await expect(call('crm.deal.fields', {})).rejects.toThrow('Битрикс24 не ответил за 0 с (crm.deal.fields)')
  })

  it('ответ Битрикса не дошёл, а сделка создалась — при повторе находит её по метке и обновляет, вторую не создаёт', async () => {
    const methods: string[] = []
    const call: Call = async (m, params: any) => {
      methods.push(m)
      if (m === 'crm.deal.list') return params.filter.ORIGIN_ID === 'd1' ? [{ ID: '777' }] : []
      if (m === 'crm.duplicate.findbycomm') return { COMPANY: ['42'], CONTACT: ['43'] }
      return true
    }
    const saved: any[] = []
    const r = await pushDeal(call, payload(), CFG, META, null, async (x) => { saved.push(x) })
    expect(r.deal).toBe('777')
    expect(methods).not.toContain('crm.deal.add')
    expect(methods).toContain('crm.deal.update')
    expect(saved).toContainEqual({ deal: '777' })
  })

  it('новая сделка помечается меткой CRM (ORIGIN_ID)', () => {
    const f = buildDealFields(payload(), CFG, META, {}, true)
    expect(f).toMatchObject({ ORIGINATOR_ID: 'sillan-crm', ORIGIN_ID: 'd1' })
  })

  it('дубли: незнакомые CRM копии известных сделок; чужие сделки не трогает', () => {
    const rows = [
      { ID: '10', TITLE: 'Сервис: A — Насос', COMPANY_ID: '1', CATEGORY_ID: '6', DATE_CREATE: '' },
      { ID: '11', TITLE: 'Сервис: A — Насос', COMPANY_ID: '1', CATEGORY_ID: '6', DATE_CREATE: '' },
      { ID: '12', TITLE: 'Сервис: B — Насос', COMPANY_ID: '2', CATEGORY_ID: '6', DATE_CREATE: '' },
      { ID: '13', TITLE: 'Сервис: C — Пресс', COMPANY_ID: '3', CATEGORY_ID: '6', DATE_CREATE: '' },
    ]
    expect(findDuplicates(rows, new Set(['11', '12'])).map((d) => d.ID)).toEqual(['10'])
  })
})
