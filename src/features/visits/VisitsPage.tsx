import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner, useToast } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtDateTime, startOfMonthISO, todayISO } from '@/lib/format'
import { exportCsv } from '@/lib/export'
import { INTEREST_LABEL, VISIT_STATUS_COLOR, VISIT_STATUS_LABEL } from '@/lib/labels'
import { VISIT_LIST_FIELDS, type PlanVisit } from './api'
import { VisitDetails } from './VisitDetails'
import { VisitResultDialog } from './VisitResultDialog'

const PAGE = 50

export default function VisitsPage() {
  const [params, setParams] = useSearchParams()
  const d = useDicts()
  const perms = usePerms()
  const { session } = useAuth()
  const toast = useToast()
  const f = {
    from: params.get('from') ?? startOfMonthISO(),
    to: params.get('to') ?? todayISO(),
    manager: params.get('manager') ?? '',
    status: params.get('status') ?? '',
    page: Number(params.get('page') ?? 1),
  }
  const set = (patch: Partial<typeof f>) => {
    const p = new URLSearchParams(params)
    Object.entries({ ...patch, page: patch.page ?? 1 }).forEach(([k, v]) => (v ? p.set(k, String(v)) : p.delete(k)))
    setParams(p, { replace: true })
  }

  const build = useMemo(() => () => {
    let q = supabase.from('visits').select(VISIT_LIST_FIELDS, { count: 'exact' }).gte('planned_date', f.from).lte('planned_date', f.to)
    if (f.manager) q = q.eq('manager_id', f.manager)
    if (f.status) q = q.eq('status', f.status)
    return q.order('planned_date', { ascending: false }).order('position')
  }, [f.from, f.to, f.manager, f.status])

  const list = useQuery({
    queryKey: ['visits', 'history', f],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await build().range((f.page - 1) * PAGE, f.page * PAGE - 1)
      if (res.error) throw res.error
      return { rows: res.data as unknown as PlanVisit[], total: res.count ?? 0 }
    },
  })
  const [open, setOpen] = useState<PlanVisit | null>(null)
  const [edit, setEdit] = useState<PlanVisit | null>(null)
  const [exporting, setExporting] = useState(false)

  const doExport = async () => {
    setExporting(true)
    try {
      const rows: PlanVisit[] = []
      for (let from = 0; from < 20000; from += 1000) {
        const part = unwrap(await build().range(from, from + 999)) as unknown as PlanVisit[]
        rows.push(...part)
        if (part.length < 1000) break
      }
      exportCsv(rows, [
        { header: 'Дата', value: (r) => fmtDate(r.planned_date) },
        { header: 'Факт', value: (r) => (r.actual_at ? fmtDateTime(r.actual_at) : '') },
        { header: 'Сотрудник', value: (r) => d.profileName(r.manager_id) },
        { header: 'Клиент', value: (r) => r.location?.name ?? '' },
        { header: 'Город', value: (r) => r.location?.city ?? '' },
        { header: 'Статус', value: (r) => VISIT_STATUS_LABEL[r.status] },
        { header: 'Цель', value: (r) => r.purpose ?? '' },
        { header: 'Результат', value: (r) => r.result ?? '' },
        { header: 'Заинтересованность', value: (r) => (r.interest ? INTEREST_LABEL[r.interest] : '') },
        { header: 'Следующий шаг', value: (r) => r.next_step ?? '' },
        { header: 'Следующий контакт', value: (r) => (r.next_contact_date ? fmtDate(r.next_contact_date) : '') },
      ], `visits_${f.from}_${f.to}.csv`)
    } catch (e) {
      toast.error(e)
    } finally {
      setExporting(false)
    }
  }

  const rows = list.data?.rows ?? []
  return (
    <div>
      <PageHeader title="История визитов" subtitle="Все запланированные и проведённые посещения" actions={<Button icon={<Download className="size-4" />} loading={exporting} disabled={!list.data?.total} onClick={doExport}>CSV</Button>} />
      <Card className="mb-3" bodyClassName="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
        <label className="text-xs text-slate-500">С<Input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="text-xs text-slate-500">По<Input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
        <label className="text-xs text-slate-500">Статус
          <Select value={f.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Все</option>
            {Object.entries(VISIT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </label>
        {perms.view_team && (
          <label className="text-xs text-slate-500">Сотрудник
            <Select value={f.manager} onChange={(e) => set({ manager: e.target.value })}>
              <option value="">Все</option>
              {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
            </Select>
          </label>
        )}
      </Card>
      <Card bodyClassName="p-0">
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !rows.length ? (
          <EmptyState title="Визитов за период нет">Измените период или запланируйте визиты в разделе «План посещений».</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Дата</th><th>Клиент</th><th>Сотрудник</th><th>Статус</th><th>Цель / результат</th><th>Интерес</th><th>Следующий шаг</th></tr></thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.id} className="cursor-pointer" onClick={() => setOpen(v)}>
                      <td className="whitespace-nowrap">{fmtDate(v.planned_date)}</td>
                      <td><Link to={`/clients/${v.location_id}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline">{v.location?.name ?? '—'}</Link><div className="text-xs text-slate-500">{v.location?.city}</div></td>
                      <td>{d.profileName(v.manager_id)}</td>
                      <td><Badge color={VISIT_STATUS_COLOR[v.status]}>{VISIT_STATUS_LABEL[v.status]}</Badge></td>
                      <td className="max-w-sm"><div className="line-clamp-2">{v.result || v.purpose || <span className="text-slate-400">—</span>}</div></td>
                      <td>{v.interest ? INTEREST_LABEL[v.interest] : '—'}</td>
                      <td className="max-w-xs"><div className="line-clamp-2">{v.next_step ?? '—'}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={f.page} pageSize={PAGE} total={list.data?.total ?? 0} onPage={(p) => set({ page: p })} />
          </>
        )}
      </Card>
      {open && (
        <VisitDetails visit={open} locationName={open.location?.name ?? ''} onClose={() => setOpen(null)}
          onEdit={(open.manager_id === session?.user.id || perms.edit_all) && ['planned', 'done', 'failed'].includes(open.status) ? () => { setEdit(open); setOpen(null) } : undefined} />
      )}
      {edit && <VisitResultDialog visit={edit} locationName={edit.location?.name ?? ''} onClose={() => setEdit(null)} />}
    </div>
  )
}
