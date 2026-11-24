/** Выгрузка плана посещений за период в Excel: сводка по неделям + лист на каждого торгового. */
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { formatPhone } from '@/lib/phone'

export interface PlanExportRow {
  planned_date: string
  position: number
  status: string
  manager_id: string
  manager: { full_name: string | null } | null
  location: { name: string; confirmed_address: string | null; source_address: string | null; city: string | null; phones: string[] | null; source_category: string | null } | null
}

const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const STATUS: Record<string, string> = { planned: 'Запланирован', done: 'Выполнен' }

export async function fetchPlanRange(from: string, to: string, managerIds?: string[]): Promise<PlanExportRow[]> {
  const rows: PlanExportRow[] = []
  const page = 1000
  for (let off = 0; ; off += page) {
    let q = supabase.from('visits')
      .select('planned_date,position,status,manager_id,manager:profiles!visits_manager_id_fkey(full_name),location:locations(name,confirmed_address,source_address,city,phones,source_category)')
      .gte('planned_date', from).lte('planned_date', to).in('status', ['planned', 'done'])
      .order('manager_id').order('planned_date').order('position').range(off, off + page - 1)
    if (managerIds?.length) q = q.in('manager_id', managerIds)
    const part = unwrap(await q) as unknown as PlanExportRow[]
    rows.push(...part)
    if (part.length < page) break
  }
  return rows
}

/** Понедельник недели для даты YYYY-MM-DD */
export function weekStart(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow)
  return d.toISOString().slice(0, 10)
}
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`

export function groupPlan(rows: PlanExportRow[]) {
  const byRep = new Map<string, { name: string; rows: PlanExportRow[] }>()
  for (const r of rows) {
    const g = byRep.get(r.manager_id) ?? { name: r.manager?.full_name || 'Без имени', rows: [] }
    g.rows.push(r)
    byRep.set(r.manager_id, g)
  }
  return [...byRep.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

export async function exportPlanXlsx(from: string, to: string, managerIds?: string[]) {
  const rows = await fetchPlanRange(from, to, managerIds)
  if (!rows.length) throw new Error('За этот период в плане нет точек')
  const reps = groupPlan(rows)
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const bold = { bold: true }
  const head = (ws: import('exceljs').Worksheet) => {
    ws.getRow(1).font = bold
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    ws.views = [{ state: 'frozen', ySplit: 1 }]
  }

  // Сводка: торговый × неделя (точек)
  const weeks = [...new Set(rows.map((r) => weekStart(r.planned_date)))].sort()
  const sum = wb.addWorksheet('Сводка')
  sum.columns = [{ header: 'Торговый', width: 28 }, ...weeks.map((w) => {
    const end = new Date(w + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 4)
    return { header: `${ddmm(w)}–${ddmm(end.toISOString().slice(0, 10))}`, width: 13 }
  }), { header: 'Всего точек', width: 12 }, { header: 'Рабочих дней', width: 13 }]
  for (const rep of reps) {
    const perWeek = weeks.map((w) => rep.rows.filter((r) => weekStart(r.planned_date) === w).length)
    sum.addRow([rep.name, ...perWeek, rep.rows.length, new Set(rep.rows.map((r) => r.planned_date)).size])
  }
  sum.addRow(['Итого', ...weeks.map((w) => rows.filter((r) => weekStart(r.planned_date) === w).length), rows.length, ''])
  sum.lastRow!.font = bold
  head(sum)
  sum.addRow([])
  sum.addRow([`План посещений ${ddmm(from)}.${from.slice(0, 4)} – ${ddmm(to)}.${to.slice(0, 4)}. Выгружен ${new Date().toLocaleString('ru-RU')}.`])
  sum.addRow(['План пересобирается каждый вечер (закрытые точки убираются, новые добавляются) — актуальная версия в CRM.'])

  // Лист на каждого торгового: дни подряд, точки в порядке объезда
  for (const rep of reps) {
    const ws = wb.addWorksheet(rep.name.slice(0, 31))
    ws.columns = [
      { header: 'Дата', width: 11 }, { header: 'День', width: 6 }, { header: '№', width: 5 },
      { header: 'Точка', width: 42 }, { header: 'Адрес', width: 40 }, { header: 'Телефон', width: 18 },
      { header: 'Вид деятельности', width: 30 }, { header: 'Статус', width: 14 },
    ]
    let prev = ''
    let n = 0
    let shade = false
    for (const r of rep.rows) {
      if (r.planned_date !== prev) { n = 0; shade = !shade; prev = r.planned_date }
      n++
      const l = r.location
      const d = new Date(r.planned_date + 'T00:00:00Z')
      const row = ws.addRow([
        `${ddmm(r.planned_date)}.${r.planned_date.slice(0, 4)}`, DAYS[d.getUTCDay()], n,
        l?.name ?? '', l?.confirmed_address || l?.source_address || '', l?.phones?.[0] ? formatPhone(l.phones[0]) : '',
        (l?.source_category ?? '').split(',')[0].trim(), STATUS[r.status] ?? r.status,
      ])
      if (shade) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
      if (n === 1) row.getCell(1).font = bold
    }
    head(ws)
    ws.autoFilter = { from: 'A1', to: 'H1' }
  }

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `План посещений ${ddmm(from)}–${ddmm(to)}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { points: rows.length, reps: reps.length }
}
