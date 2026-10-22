import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, PageHeader, QueryState, Tabs, useToast } from '@/components/ui'
import { usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDateTime } from '@/lib/format'
import type { ImportJob } from '@/lib/types'
import { ImportWizard } from './ImportWizard'
import { downloadJobReport } from './report'

const STATUS: Record<string, { label: string; color: string }> = {
  processing: { label: 'Выполняется / прерван', color: 'amber' }, done: { label: 'Готово', color: 'green' },
  partial: { label: 'С ошибками', color: 'orange' }, failed: { label: 'Прерван', color: 'rose' },
}
const MODE: Record<string, string> = { add_new: 'Только новые', update_allowed: 'Обновление полей', skip_existing: 'Пропуск существующих' }

export default function ImportPage() {
  const perms = usePerms()
  const [tab, setTab] = useState<'new' | 'log'>(perms.import ? 'new' : 'log')
  return (
    <div>
      <PageHeader title="Импорт данных" subtitle="Загрузка организаций и точек из выгрузок 2GIS и других таблиц (CSV, XLSX)" />
      <Tabs value={tab} onChange={setTab} tabs={[...(perms.import ? [{ value: 'new' as const, label: 'Новый импорт' }] : []), { value: 'log', label: 'Журнал импорта' }]} />
      <div className="mt-4">{tab === 'new' && perms.import ? <ImportWizard /> : <ImportLog />}</div>
    </div>
  )
}

function ImportLog() {
  const d = useDicts()
  const toast = useToast()
  const q = useQuery({
    queryKey: ['import-jobs'],
    queryFn: async () => unwrap(await supabase.from('import_jobs').select('*').order('created_at', { ascending: false }).limit(100)) as ImportJob[],
  })
  return (
    <Card bodyClassName="p-0">
      <QueryState query={q} empty={!q.data?.length} emptyTitle="Импортов ещё не было">
        {!q.data?.length ? <EmptyState title="Импортов ещё не было" /> : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Дата</th><th>Файл</th><th>Пользователь</th><th>Режим</th><th>Строк</th><th>Создано</th><th>Обновлено</th><th>Пропущено</th><th>Конфликты</th><th>Ошибки</th><th>Статус</th><th /></tr></thead>
              <tbody>
                {q.data.map((j) => (
                  <tr key={j.id}>
                    <td className="whitespace-nowrap">{fmtDateTime(j.created_at)}</td>
                    <td className="max-w-xs truncate" title={j.file_name}>{j.file_name}{j.sheet_name && <div className="text-xs text-slate-500">лист: {j.sheet_name}</div>}</td>
                    <td>{d.profileName(j.created_by)}</td>
                    <td className="text-xs">{MODE[j.mode]}</td>
                    {[j.total_rows, j.created_count, j.updated_count, j.skipped_count, j.conflict_count, j.error_count].map((v, i) => <td key={i} className={`tabular-nums ${i === 5 && v ? 'font-medium text-rose-600' : ''}`}>{v}</td>)}
                    <td><Badge color={STATUS[j.status]?.color}>{STATUS[j.status]?.label ?? j.status}</Badge></td>
                    <td className="whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => downloadJobReport(j.id, j.file_name).catch((e) => toast.error(e))}>Отчёт</Button>
                      {(j.error_count > 0 || j.conflict_count > 0) && <Button size="sm" variant="ghost" onClick={() => downloadJobReport(j.id, j.file_name, true).catch((e) => toast.error(e))}>Ошибки</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </Card>
  )
}
