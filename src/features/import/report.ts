import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { exportCsv } from '@/lib/export'

const ACTION: Record<string, string> = { created: 'Создано', updated: 'Обновлено', skipped: 'Пропущено', conflict: 'Конфликт', error: 'Ошибка' }

/** Отчёт по строкам импорта (CSV): номер строки, результат, причина, исходные данные */
export async function downloadJobReport(jobId: string, fileName: string, onlyProblems = false) {
  const rows: { row_number: number; action: string; message: string | null; raw: Record<string, unknown> | null; location_id: string | null }[] = []
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('import_rows').select('row_number,action,message,raw,location_id').eq('job_id', jobId).order('row_number')
    if (onlyProblems) q = q.in('action', ['error', 'conflict', 'skipped'])
    const part = unwrap(await q.range(from, from + 999)) as typeof rows
    rows.push(...part)
    if (part.length < 1000) break
  }
  const rawKeys = [...new Set(rows.flatMap((r) => Object.keys(r.raw ?? {})))]
  exportCsv(rows, [
    { header: 'Строка файла', value: (r) => r.row_number },
    { header: 'Результат', value: (r) => ACTION[r.action] ?? r.action },
    { header: 'Причина / комментарий', value: (r) => r.message ?? '' },
    { header: 'ID записи в CRM', value: (r) => r.location_id ?? '' },
    ...rawKeys.map((k) => ({ header: k, value: (r: (typeof rows)[number]) => { const v = r.raw?.[k]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v) } })),
  ], `import_report_${fileName.replace(/\.\w+$/, '')}_${jobId.slice(0, 8)}.csv`)
}
