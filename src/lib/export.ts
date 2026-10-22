/** Выгрузка таблиц в CSV (Excel открывает с разделителем «;») и XLSX. */
export interface ExportColumn<T> { header: string; value: (row: T) => string | number | null | undefined }

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function toCsv<T>(rows: T[], cols: ExportColumn<T>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    // защита от формул при открытии в Excel
    const safe = /^[=+\-@]/.test(s) && !/^[+-]?\d/.test(s) ? "'" + s : s
    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const lines = [cols.map((c) => esc(c.header)).join(';')]
  for (const r of rows) lines.push(cols.map((c) => esc(c.value(r))).join(';'))
  return lines.join('\r\n')
}

export function exportCsv<T>(rows: T[], cols: ExportColumn<T>[], fileName: string) {
  download(new Blob(['﻿' + toCsv(rows, cols)], { type: 'text/csv;charset=utf-8' }), fileName)
}

export async function exportXlsx<T>(rows: T[], cols: ExportColumn<T>[], fileName: string, sheetName = 'Данные') {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName.slice(0, 31))
  ws.columns = cols.map((c) => ({ header: c.header, width: Math.min(50, Math.max(12, c.header.length + 2)) }))
  for (const r of rows) ws.addRow(cols.map((c) => c.value(r) ?? ''))
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  const buf = await wb.xlsx.writeBuffer()
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName)
}
