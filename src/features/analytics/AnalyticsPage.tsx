import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { Button, Card, PageHeader, QueryState, Stat } from '@/components/ui'
import { PeriodFilters, type PeriodState } from '@/components/PeriodFilters'
import { usePerms } from '@/auth/AuthProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { startOfMonthISO, todayISO } from '@/lib/format'
import { exportCsv } from '@/lib/export'
import { ROLE_LABEL } from '@/lib/labels'
import { fetchFilterOptions } from '@/features/clients/api'
import { useDashboard } from '@/features/dashboard/DashboardPage'

interface ManagerRow {
  manager_id: string; manager_name: string; role: string; assigned_clients: number; visits_planned: number; visits_done: number; visits_failed: number
  contacted_clients: number; requests_created: number; deals_created: number; deals_open_amount: number; overdue_actions: number
}

const DEFINITIONS: [string, string][] = [
  ['Закреплено клиентов', 'Точки (не в архиве), у которых сотрудник указан ответственным — на текущий момент.'],
  ['Запланировано визитов', 'Визиты с плановой датой в выбранном периоде, кроме перенесённых (перенос учитывается на новую дату).'],
  ['Выполнено визитов', 'Визиты со статусом «Выполнен», фактическое время которых попадает в период.'],
  ['Не состоялось', 'Визиты со статусом «Не состоялся» с плановой датой в периоде.'],
  ['Клиентов с контактом', 'Разные точки, где за период был хотя бы один выполненный визит.'],
  ['Создано заявок', 'Заявки в отделы, созданные сотрудником в периоде (визит заявкой не считается).'],
  ['Просрочено действий', 'Запланированные визиты на прошедшие даты + клиенты с прошедшей датой следующего контакта без нового визита.'],
]

export default function AnalyticsPage() {
  const perms = usePerms()
  const [p, setP] = useState<PeriodState>({ from: startOfMonthISO(), to: todayISO(), manager: '', city: '', direction: '' })
  const options = useQuery({ queryKey: ['clients', 'options'], queryFn: fetchFilterOptions, staleTime: 5 * 60_000 })
  const dash = useDashboard(p)
  const q = useQuery({
    queryKey: ['analytics', 'managers', p],
    queryFn: async () => unwrap(await supabase.rpc('manager_stats', { p_from: p.from, p_to: p.to, p_city: p.city || null, p_direction: p.direction || null })) as ManagerRow[],
  })
  const rows = (q.data ?? []).filter((r) => !p.manager || r.manager_id === p.manager).map((r) => ({ ...r, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v])) })) as ManagerRow[]
  const total = (k: keyof ManagerRow) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0)

  const doExport = () => exportCsv(rows, [
    { header: 'Сотрудник', value: (r) => r.manager_name },
    { header: 'Роль', value: (r) => ROLE_LABEL[r.role] ?? r.role },
    { header: 'Закреплено клиентов', value: (r) => r.assigned_clients },
    { header: 'Запланировано визитов', value: (r) => r.visits_planned },
    { header: 'Выполнено визитов', value: (r) => r.visits_done },
    { header: 'Не состоялось', value: (r) => r.visits_failed },
    { header: 'Клиентов с контактом', value: (r) => r.contacted_clients },
    { header: 'Создано заявок', value: (r) => r.requests_created },
    { header: 'Просрочено действий', value: (r) => r.overdue_actions },
  ], `analytics_${p.from}_${p.to}.csv`)

  return (
    <div className="space-y-4">
      <PageHeader title="Аналитика" subtitle={perms.view_team ? 'Работа команды за период' : 'Ваша работа за период'} actions={<Button icon={<Download className="size-4" />} disabled={!rows.length} onClick={doExport}>CSV</Button>} />
      <Card bodyClassName="p-3"><PeriodFilters value={p} onChange={setP} cities={options.data?.cities ?? []} /></Card>
      <QueryState query={dash}>
        {dash.data && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Запланировано визитов" value={dash.data.visits_planned_period} />
            <Stat label="Выполнено визитов" value={dash.data.visits_done} />
            <Stat label="Выполнение плана" value={dash.data.visits_planned_period ? `${Math.round((dash.data.visits_done / dash.data.visits_planned_period) * 100)}%` : '—'} hint="Выполнено / запланировано" />
            <Stat label="Создано заявок" value={dash.data.requests_created_period} />
            <Stat label="Новых точек" value={dash.data.locations_new} />
          </div>
        )}
      </QueryState>
      <Card title="По сотрудникам" bodyClassName="p-0">
        <QueryState query={q} empty={!rows.length} emptyTitle="Нет данных за период">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr><th>Сотрудник</th><th>Клиентов</th><th>Запланировано</th><th>Выполнено</th><th>Не состоялось</th><th>С контактом</th><th>Заявок</th><th>Просрочено</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.manager_id}>
                    <td><div className="font-medium">{r.manager_name || '—'}</div><div className="text-xs text-slate-500">{ROLE_LABEL[r.role]}</div></td>
                    <td className="tabular-nums">{r.assigned_clients}</td>
                    <td className="tabular-nums">{r.visits_planned}</td>
                    <td className="tabular-nums">{r.visits_done}{r.visits_planned ? <span className="text-xs text-slate-500"> ({Math.round((r.visits_done / r.visits_planned) * 100)}%)</span> : null}</td>
                    <td className="tabular-nums">{r.visits_failed}</td>
                    <td className="tabular-nums">{r.contacted_clients}</td>
                    <td className="tabular-nums">{r.requests_created}</td>
                    <td className={`tabular-nums ${r.overdue_actions ? 'font-medium text-rose-600' : ''}`}>{r.overdue_actions}</td>
                  </tr>
                ))}
                {rows.length > 1 && (
                  <tr className="bg-slate-50 font-medium">
                    <td>Итого</td>
                    {(['assigned_clients', 'visits_planned', 'visits_done', 'visits_failed', 'contacted_clients', 'requests_created'] as const).map((k) => <td key={k} className="tabular-nums">{total(k)}</td>)}
                    <td className="tabular-nums">{total('overdue_actions')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </QueryState>
      </Card>
      <Card title="Как считаются показатели">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {DEFINITIONS.map(([t, d]) => <div key={t}><dt className="font-medium text-slate-800">{t}</dt><dd className="text-slate-600">{d}</dd></div>)}
        </dl>
      </Card>
    </div>
  )
}
