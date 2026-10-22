import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { decodeText, parseCsvText, parseFile } from '../import/parse'
import { autoMap, buildRow, matchDirections } from '../import/mapping'
import { defaultAction, markInFileDuplicates, summarize, type PlannedRow } from '../import/classify'
import { normAddress, normText, rowKey } from '../import/normalize'
import { toCsv } from '../export'
import type { Direction } from '../types'

const dirs: Direction[] = [
  { id: 'sto', name: 'Автосервис / СТО', keywords: ['автосервис', 'сто', 'ремонт авто'], sort: 10, is_active: true },
  { id: 'tire', name: 'Шиномонтаж', keywords: ['шиномонтаж', 'вулканизац'], sort: 20, is_active: true },
  { id: 'wash', name: 'Автомойка', keywords: ['автомойк', 'мойка'], sort: 90, is_active: true },
  { id: 'off', name: 'Отключено', keywords: ['шиномонтаж'], sort: 99, is_active: false },
]

const fileFrom = (name: string, buf: ArrayBuffer | Uint8Array) => ({ name, arrayBuffer: async () => (buf instanceof Uint8Array ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf) as ArrayBuffer })

describe('нормализация (как в базе)', () => {
  it('текст и адрес', () => {
    expect(normText('  СТО «Ёлка»-2 ')).toBe('сто елка 2')
    expect(normAddress('г. Алматы, ул. Тимирязева, д. 42')).toBe('алматы тимирязева 42')
    expect(normAddress('пр-т Абая 10, р-н Бостандыкский')).toBe('абая 10 бостандыкский')
    expect(normAddress('Улица Тимирязева 42')).toBe(normAddress('ул. Тимирязева, 42'))
  })
  it('ключ строки: внешний ID важнее адреса', () => {
    expect(rowKey({ external_id: ' 123 ', name: 'x' })).toBe('ext:123')
    expect(rowKey({ name: 'Мотор', city: 'Алматы', address: 'ул. Абая 1' })).toBe('addr|мотор|алматы|абая 1')
    expect(rowKey({ name: 'Без адреса' })).toBeNull()
  })
})

describe('чтение файлов', () => {
  it('CSV с «;» и Windows-1251', async () => {
    const text = 'Название;Город;Телефон\nСТО Мотор;Алматы;+7 701 111 22 33\n\n'
    expect(parseCsvText(text)).toMatchObject({ headers: ['Название', 'Город', 'Телефон'], rows: [{ 'Название': 'СТО Мотор', 'Город': 'Алматы' }], rowNumbers: [2] })
    // «Мотор» в cp1251
    const cp = new Uint8Array([0xcc, 0xee, 0xf2, 0xee, 0xf0])
    expect(decodeText(cp.buffer)).toBe('Мотор')
  })
  it('XLSX: несколько листов, пустые строки, одинаковые заголовки', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Пусто')
    const ws = wb.addWorksheet('Выгрузка')
    ws.addRow(['Название', 'Телефон', 'Телефон', 'Координаты'])
    ws.addRow(['Шина Мастер', '+7 727 300 10 10', '87011112233', '43.2389, 76.8897'])
    ws.addRow([])
    ws.addRow(['Мойка Люкс', 12345678, '', ''])
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer
    const f = await parseFile(fileFrom('2gis.xlsx', buf))
    expect(f.sheets).toEqual(['Выгрузка'])
    const s = await f.read('Выгрузка')
    expect(s.headers).toEqual(['Название', 'Телефон', 'Телефон (2)', 'Координаты'])
    expect(s.rows).toHaveLength(2)
    expect(s.rowNumbers).toEqual([2, 4])
    expect(s.rows[1]['Телефон']).toBe('12345678')
  })
  it('понятная ошибка для .xls и других форматов', async () => {
    await expect(parseFile(fileFrom('old.xls', new ArrayBuffer(4)))).rejects.toThrow('.xlsx')
    await expect(parseFile(fileFrom('photo.jpg', new ArrayBuffer(4)))).rejects.toThrow('.csv и .xlsx')
  })
})

describe('сопоставление и проверка строк', () => {
  it('автоматически узнаёт столбцы 2GIS', () => {
    const m = autoMap(['Название', 'Рубрики', 'Город', 'Адрес', 'Телефон', 'Телефон (2)', 'Сайт', 'ID', 'Ссылка на 2ГИС', 'Непонятно'])
    expect(m).toMatchObject({ 'Название': 'name', 'Рубрики': 'category', 'Город': 'city', 'Адрес': 'address', 'Телефон': 'phones', 'Телефон (2)': 'phones', 'Сайт': 'website', 'ID': 'external_id', 'Ссылка на 2ГИС': 'source_url', 'Непонятно': '' })
  })
  it('подбирает направления по ключевым словам, неактивные не используются', () => {
    expect(matchDirections('Шиномонтаж, Автомойки', dirs).sort()).toEqual(['tire', 'wash'])
    expect(matchDirections('Магазин стоматологии', dirs)).toEqual([]) // «сто» только как начало слова
    expect(matchDirections('СТО Мотор', dirs)).toEqual(['sto'])
  })
  it('собирает строку: телефоны из нескольких столбцов, координаты, ошибки', () => {
    const mapping = { 'Название': 'name', 'Т1': 'phones', 'Т2': 'phones', 'Коорд': 'coords', 'БИН': 'bin', 'Рубрика': 'category' } as const
    const ok = buildRow({ 'Название': 'Шина Мастер', 'Т1': '+7 727 300 10 10, 87011112233', 'Т2': '87011112233', 'Коорд': '43,2389; 76,8897', 'БИН': '1234', 'Рубрика': 'Шиномонтаж' }, { ...mapping }, dirs)
    expect(ok.errors).toEqual([])
    expect(ok.data.phones).toEqual(['+7 727 300 10 10', '87011112233'])
    expect(ok.data).toMatchObject({ lat: 43.2389, lng: 76.8897, bin: '', direction_ids: ['tire'] })
    expect(ok.warnings[0]).toContain('БИН')
    const bad = buildRow({ 'Название': '', 'Коорд': '200, 300' }, { ...mapping }, dirs)
    expect(bad.errors).toEqual(['Не заполнено название'])
    expect(bad.data.lat).toBeNull()
  })
})

describe('классификация строк перед импортом', () => {
  const mk = (row: number, name: string, extra: Partial<PlannedRow> = {}): PlannedRow => ({
    row, raw: {}, action: 'create',
    built: { data: { name, company_name: '', legal_name: '', bin: '', category: '', city: 'Алматы', district: '', address: 'ул. Абая 1', phones: [], website: '', lat: null, lng: null, external_id: '', source_url: '', direction_ids: [] }, errors: name ? [] : ['Не заполнено название'], warnings: [] },
    ...extra,
  })
  it('повторы в файле, совпадения, конфликты, ошибки — по режиму', () => {
    const rows = [
      mk(2, 'Мотор'),
      mk(3, 'Мотор'), // повтор строки 2
      mk(4, 'Шина', { preview: { row: 4, key: '', match: 'external', location_id: 'L1', possible: [] } }),
      mk(5, 'Похожий', { preview: { row: 5, key: '', match: null, location_id: null, possible: [{ id: 'L2', name: 'Похожий', city: null, address: null, phones: [], reason: 'Совпал телефон' }] } }),
      mk(6, ''),
    ]
    rows[2].built.data.address = 'другой'
    rows[3].built.data.address = 'третий'
    markInFileDuplicates(rows)
    for (const r of rows) Object.assign(r, defaultAction(r, 'add_new'))
    expect(rows.map((r) => r.action)).toEqual(['create', 'skip', 'skip', 'conflict', 'error'])
    expect(rows[1].message).toContain('строки 2')
    expect(defaultAction(rows[2], 'update_allowed')).toMatchObject({ action: 'update', location_id: 'L1' })
    expect(summarize(rows)).toMatchObject({ total: 5, create: 1, skip: 2, conflict: 1, error: 1, existing: 1, inFile: 1 })
  })
})

describe('экспорт CSV', () => {
  it('экранирует разделители, кавычки и формулы', () => {
    const csv = toCsv([{ a: 'Мотор; СТО', b: 'Сказал "да"', c: '=СУММ(A1)', d: '+77011234567' }], [
      { header: 'A', value: (r) => r.a }, { header: 'B', value: (r) => r.b }, { header: 'C', value: (r) => r.c }, { header: 'D', value: (r) => r.d },
    ])
    expect(csv).toBe('A;B;C;D\r\n"Мотор; СТО";"Сказал ""да""";\'=СУММ(A1);+77011234567')
  })
})
