import { rowKey } from './normalize'
import type { BuiltRow } from './mapping'

export type ImportMode = 'add_new' | 'update_allowed' | 'skip_existing'
export type RowAction = 'create' | 'update' | 'merge' | 'skip' | 'conflict' | 'error'

export interface Candidate { id: string; name: string; city: string | null; address: string | null; phones: string[]; reason: string }
export interface PreviewItem { row: number; key: string; match: 'external' | 'exact' | null; location_id: string | null; possible: Candidate[] }

export interface PlannedRow {
  row: number
  built: BuiltRow
  raw: Record<string, string>
  preview?: PreviewItem
  inFileDuplicateOf?: number
  action: RowAction
  location_id?: string | null
  message?: string
}

/** Повторы внутри одного файла: вторая и следующие строки с тем же ключом пропускаются */
export function markInFileDuplicates(rows: PlannedRow[]) {
  const seen = new Map<string, number>()
  for (const r of rows) {
    if (r.built.errors.length) continue
    const k = rowKey(r.built.data)
    if (!k) continue
    const first = seen.get(k)
    if (first !== undefined) r.inFileDuplicateOf = first
    else seen.set(k, r.row)
  }
}

/** Действие по умолчанию для строки с учётом режима импорта */
export function defaultAction(r: PlannedRow, mode: ImportMode): Pick<PlannedRow, 'action' | 'location_id' | 'message'> {
  if (r.built.errors.length) return { action: 'error', message: r.built.errors.join('; ') }
  if (r.inFileDuplicateOf !== undefined) return { action: 'skip', message: `Повтор строки ${r.inFileDuplicateOf} в этом же файле` }
  const p = r.preview
  if (p?.match) {
    if (mode === 'update_allowed') return { action: 'update', location_id: p.location_id, message: 'Обновлены разрешённые поля' }
    return { action: 'skip', location_id: p.location_id, message: 'Уже есть в базе' }
  }
  if (p && p.possible.length) return { action: 'conflict', message: 'Возможный дубликат — нужно решение' }
  return { action: 'create' }
}

export function summarize(rows: PlannedRow[]) {
  const s = { total: rows.length, create: 0, update: 0, merge: 0, skip: 0, conflict: 0, error: 0, existing: 0, inFile: 0 }
  for (const r of rows) {
    s[r.action]++
    if (r.preview?.match) s.existing++
    if (r.inFileDuplicateOf !== undefined) s.inFile++
  }
  return s
}
