import { describe, expect, it } from 'vitest'
import { buildRow, suggestMapping, TEMPLATE_HEADERS, type CrmField } from '../import/mapping'
import { parseCsvText } from '../import/parse'
import type { Direction } from '../types'

// Заголовки, как их выгружает Apify «2gis Places Scraper» в CSV (вложенные поля через «/»)
const APIFY = ['id', 'title', 'shortName', 'category', 'rubrics/0', 'rubrics/1', 'city', 'district', 'street', 'houseNumber', 'address',
  'location/lat', 'location/lng', 'phoneText/0', 'phoneValue/0', 'phoneValue/1', 'email', 'website', 'url', 'brand', 'totalScore', 'reviews/0/text', 'mainPhotoUrl']

const dirs: Direction[] = [
  { id: 'tire', name: 'Шиномонтаж и правка дисков', keywords: ['шиномонтаж', 'правка дисков'], sort: 1, is_active: true },
  { id: 'sto', name: 'Автосервис / СТО', keywords: ['автосервис', 'сто'], sort: 2, is_active: true },
]

describe('выгрузка Apify (2GIS) без переименования столбцов', () => {
  const r = suggestMapping(APIFY)

  it('очевидные столбцы сопоставляются автоматически', () => {
    expect(r.mapping).toMatchObject({
      id: 'external_id', title: 'name', category: '', 'rubrics/0': 'category', 'rubrics/1': 'category', city: 'city',
      district: 'district', address: 'address', 'location/lat': 'lat', 'location/lng': 'lng', 'phoneText/0': 'phones',
      'phoneValue/0': 'phones', 'phoneValue/1': 'phones', website: 'website', url: 'source_url',
    })
    expect(r.auto).toContain('title')
    expect(r.suggestions.category.reason).toContain('служебный код')
  })

  it('неоднозначные столбцы не назначаются без подтверждения', () => {
    for (const h of ['shortName', 'street', 'brand']) expect(r.mapping[h]).toBe('')
    expect(r.suggestions.shortName.field).toBe('name')
    expect(r.suggestions.shortName.reason).toContain('уже взято из столбца «title»')
    expect(r.suggestions.brand.field).toBe('company_name')
    for (const h of ['totalScore', 'reviews/0/text', 'mainPhotoUrl', 'email', 'houseNumber']) {
      expect(r.mapping[h]).toBe('')
    }
  })

  it('строка Apify: рубрики объединяются, телефоны не дублируются, пустые значения не выдумываются', () => {
    const row: Record<string, string> = Object.fromEntries(APIFY.map((h) => [h, '']))
    Object.assign(row, {
      id: '70000001234', title: 'Шина Мастер', category: 'Шиномонтаж', 'rubrics/0': 'Шиномонтаж', 'rubrics/1': 'Правка дисков',
      city: 'Астана', address: 'ул. Сарыарка, 5', 'location/lat': '51.1694', 'location/lng': '71.4491',
      'phoneText/0': '+7 (701) 111-22-33', 'phoneValue/0': '+77011112233', url: 'https://2gis.kz/astana/firm/70000001234',
    })
    const b = buildRow(row, r.mapping as Record<string, CrmField | ''>, dirs)
    expect(b.errors).toEqual([])
    expect(b.data).toMatchObject({
      name: 'Шина Мастер', category: 'Шиномонтаж, Правка дисков', city: 'Астана', district: '', website: '',
      lat: 51.1694, lng: 71.4491, external_id: '70000001234', source_url: 'https://2gis.kz/astana/firm/70000001234',
    })
    expect(b.data.phones).toEqual(['+77011112233'])
    expect(b.data.direction_ids).toEqual(['tire'])
  })

  it('файл без многих столбцов: обязательно только название', () => {
    const s = parseCsvText('title,city\nСТО Мотор,Астана\n,Астана\n')
    const m = suggestMapping(s.headers).mapping
    const [ok, bad] = s.rows.map((x) => buildRow(x, m, dirs))
    expect(ok.errors).toEqual([])
    expect(ok.data).toMatchObject({ phones: [], lat: null, lng: null, external_id: '', address: '' })
    expect(bad.errors).toEqual(['Не заполнено название'])
  })

  it('сайт и телефоны из пронумерованных столбцов, даже если общий столбец пустой', () => {
    const h = ['title', 'website', 'website/0', 'website/1', 'phoneText', 'phoneText/0']
    const m = suggestMapping(h).mapping
    expect(m).toMatchObject({ website: 'website', 'website/0': 'website', 'website/1': 'website', 'phoneText/0': 'phones' })
    const b = buildRow({ title: 'X', website: '', 'website/0': 'http://a.kz', 'website/1': 'http://b.kz', phoneText: '', 'phoneText/0': '+7‒708‒909‒95‒23' }, m, dirs)
    expect(b.data.website).toBe('http://a.kz')
    expect(b.data.phones).toEqual(['+7‒708‒909‒95‒23'])
    const both = buildRow({ title: 'X', 'phoneText/0': '+7‒708‒909‒95‒23', 'website/0': '', website: '', 'website/1': '', phoneText: '' , 'phoneValue/0': '+77089099523' } as Record<string, string>, { ...m, 'phoneValue/0': 'phones' }, dirs)
    expect(both.data.phones).toEqual(['+77089099523'])
  })

  it('шаблон Sillan CRM распознаётся целиком', () => {
    const m = suggestMapping(TEMPLATE_HEADERS).mapping
    expect(Object.values(m).every(Boolean)).toBe(true)
    expect(m).toMatchObject({ name: 'name', phone: 'phones', latitude: 'lat', longitude: 'lng', external_id: 'external_id', source_url: 'source_url' })
  })
})
