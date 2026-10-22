import Papa from 'papaparse'

export interface ParsedSheet {
  headers: string[]
  rows: Record<string, string>[] // ключ — заголовок столбца
  rowNumbers: number[] // номер строки в исходном файле (для журнала ошибок)
}

export interface ParsedFile {
  kind: 'csv' | 'xlsx'
  sheets: string[]
  read: (sheet?: string) => Promise<ParsedSheet>
}

/** Определить кодировку CSV: UTF-8, иначе Windows-1251 (частый вариант выгрузок из Excel) */
export function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1251').decode(buf)
  }
}

function uniqueHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((h, i) => {
    let name = String(h ?? '').trim() || `Столбец ${i + 1}`
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    if (n) name = `${name} (${n + 1})`
    return name
  })
}

export function parseCsvText(text: string): ParsedSheet {
  const res = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimiter: '' })
  const data = res.data.filter((r) => r.some((c) => String(c).trim() !== ''))
  if (!data.length) return { headers: [], rows: [], rowNumbers: [] }
  const headers = uniqueHeaders(data[0])
  const rows = data.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])))
  return { headers, rows, rowNumbers: rows.map((_, i) => i + 2) }
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[]; hyperlink?: string }
    if (o.richText) return o.richText.map((t) => t.text).join('')
    if (o.text !== undefined) return String(o.text)
    if (o.result !== undefined) return cellText(o.result)
    if (o.hyperlink) return o.hyperlink
    return ''
  }
  return String(v)
}

export async function parseXlsxBuffer(buf: ArrayBuffer): Promise<ParsedFile> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const sheets = wb.worksheets.filter((w) => w.actualRowCount > 0).map((w) => w.name)
  return {
    kind: 'xlsx',
    sheets,
    read: async (sheet) => {
      const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets.find((w) => w.actualRowCount > 0)
      if (!ws) return { headers: [], rows: [], rowNumbers: [] }
      const matrix: { n: number; cells: string[] }[] = []
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        const values = (row.values as unknown[]).slice(1).map(cellText)
        if (values.some((v) => v.trim() !== '')) matrix.push({ n, cells: values })
      })
      if (!matrix.length) return { headers: [], rows: [], rowNumbers: [] }
      const width = Math.max(...matrix.map((m) => m.cells.length))
      const headers = uniqueHeaders(Array.from({ length: width }, (_, i) => matrix[0].cells[i]))
      const body = matrix.slice(1)
      return {
        headers,
        rows: body.map((m) => Object.fromEntries(headers.map((h, i) => [h, (m.cells[i] ?? '').trim()]))),
        rowNumbers: body.map((m) => m.n),
      }
    },
  }
}

export async function parseFile(file: { name: string; arrayBuffer: () => Promise<ArrayBuffer> }): Promise<ParsedFile> {
  const buf = await file.arrayBuffer()
  if (/\.xlsx$/i.test(file.name)) return parseXlsxBuffer(buf)
  if (/\.(csv|txt|tsv)$/i.test(file.name)) {
    const sheet = parseCsvText(decodeText(buf))
    return { kind: 'csv', sheets: [], read: async () => sheet }
  }
  if (/\.xls$/i.test(file.name)) throw new Error('Старый формат .xls не поддерживается — сохраните файл как .xlsx или .csv')
  throw new Error('Поддерживаются файлы .csv и .xlsx')
}
