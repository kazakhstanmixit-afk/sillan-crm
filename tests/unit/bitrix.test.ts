import { describe, expect, it } from 'vitest'
import { bitrixCaller, buildFields, pushRequest, resolveSource, type BitrixConfig, type RequestData } from '../../supabase/functions/bitrix/index'

const cfg: BitrixConfig = { enabled: true, entity: 'lead', source_name: 'Торговый представитель', source_id: '', kinds: { service: { assigned_by_id: '15' } } }
const req: RequestData = {
  id: 'r1', number: 'СР-000007', kind: 'service', item_name: 'Подъёмник не поднимается', brand: 'Sillan', model: null, article: null,
  quantity: 1, budget: null, urgency: 'high', description: 'Течёт масло', comment: null, category: 'Подъёмники',
  location: { name: 'СТО «Мотор»', city: 'Астана', address: 'ул. Сыганак, 2', phones: ['+77015554433'], legal_name: 'ТОО «Мотор Плюс»' },
  contact: { full_name: 'Бахыт', position: 'Владелец', phone: '87011112233' }, initiator: 'Михаил Ким',
}

/** Поддельный Битрикс24: запоминает вызовы */
function fakeBitrix(handlers: Record<string, (p: Record<string, unknown>) => unknown>) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const fetchFn = (async (url: string, init: { body: string }) => {
    const method = url.match(/\/([a-z.]+)\.json$/)![1]
    const params = JSON.parse(init.body)
    calls.push({ method, params })
    const h = handlers[method]
    if (!h) return new Response(JSON.stringify({ error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found' }), { status: 404 })
    try { return new Response(JSON.stringify({ result: h(params) })) } catch (e) {
      return new Response(JSON.stringify({ error: 'ACCESS_DENIED', error_description: (e as Error).message }), { status: 403 })
    }
  }) as unknown as typeof fetch
  return { calls, call: bitrixCaller('https://sillan.bitrix24.kz/rest/1/secret/', fetchFn) }
}

describe('Битрикс24: заявка → лид/сделка', () => {
  it('лид: название, источник, описание, телефоны, ответственный по отделу', () => {
    const f = buildFields(req, cfg, 'SILLAN_REP', 'https://crm.example.kz') as Record<string, any>
    expect(f.TITLE).toBe('Сервис: Подъёмник не поднимается — СТО «Мотор»')
    expect(f.SOURCE_ID).toBe('SILLAN_REP')
    expect(f.SOURCE_DESCRIPTION).toContain('Михаил Ким')
    expect(f.COMPANY_TITLE).toBe('ТОО «Мотор Плюс»')
    expect(f.NAME).toBe('Бахыт')
    expect(f.PHONE).toEqual([{ VALUE: '87011112233', VALUE_TYPE: 'WORK' }, { VALUE: '+77015554433', VALUE_TYPE: 'WORK' }])
    expect(f.ASSIGNED_BY_ID).toBe(15)
    expect(f.COMMENTS).toContain('Что случилось: Течёт масло')
    expect(f.COMMENTS).toContain('https://crm.example.kz/requests/r1')
    expect(f.OPPORTUNITY).toBeUndefined()
  })

  it('сделка: воронка отдела и сумма в тенге', () => {
    const deal: BitrixConfig = { ...cfg, entity: 'deal', kinds: { equipment: { category_id: '3' } } }
    const f = buildFields({ ...req, kind: 'equipment', item_name: 'Балансировочный станок', budget: 1200000 }, deal, 'OTHER', '') as Record<string, any>
    expect(f).toMatchObject({ TITLE: 'Продажа оборудования: Балансировочный станок — СТО «Мотор»', CATEGORY_ID: 3, OPPORTUNITY: 1200000, CURRENCY_ID: 'KZT' })
    expect(f.PHONE).toBeUndefined()
  })

  it('источник: находит по названию, иначе создаёт, без прав — «Другое»', async () => {
    const found = fakeBitrix({ 'crm.status.list': () => [{ STATUS_ID: 'UC_7K2', NAME: 'Торговый представитель' }] })
    expect(await resolveSource(found.call, cfg)).toBe('UC_7K2')
    const created = fakeBitrix({ 'crm.status.list': () => [], 'crm.status.add': () => 101 })
    expect(await resolveSource(created.call, cfg)).toBe('SILLAN_REP')
    expect(created.calls[1].params).toMatchObject({ fields: { ENTITY_ID: 'SOURCE', NAME: 'Торговый представитель' } })
    const denied = fakeBitrix({ 'crm.status.list': () => [], 'crm.status.add': () => { throw new Error('Access denied') } })
    expect(await resolveSource(denied.call, cfg)).toBe('OTHER')
    expect(await resolveSource(found.call, { ...cfg, source_id: 'MY' })).toBe('MY')
  })

  it('создаёт лид и возвращает его номер; ошибка Битрикса — понятный текст', async () => {
    const ok = fakeBitrix({ 'crm.lead.add': () => 4521 })
    expect(await pushRequest(ok.call, req, cfg, 'SILLAN_REP', '')).toEqual({ entity: 'lead', id: '4521' })
    expect(ok.calls[0].method).toBe('crm.lead.add')
    const bad = fakeBitrix({})
    await expect(pushRequest(bad.call, req, cfg, 'X', '')).rejects.toThrow('Битрикс: Method not found')
  })
})
