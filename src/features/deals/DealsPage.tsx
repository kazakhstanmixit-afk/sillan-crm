import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Pagination, Select, Spinner, Stat } from '@/components/ui'
import { usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { fmtDate, fmtMoney, isOverdue } from '@/lib/format'
import type { Deal } from '@/lib/types'
import { DealFormModal } from './DealFormModal'
import { Plus } from 'lucide-react'
import { LocationPickDialog } from '@/features/clients/LocationPickDialog'

type Row = Deal & { location: { id: string; name: string; city: string | null } | null }
const PAGE = 50
const KIND_COLOR = { open: 'blue', won: 'green', lost: 'rose' } as const

export default function DealsPage() {
  const [params, setParams] = useSearchParams()
  const d = useDicts()
  const perms = usePerms()
  const f = { stage: params.get('stage') ?? 'open', manager: params.get('manager') ?? '', page: Number(params.get('page') ?? 1) }
  const set = (patch: Partial<typeof f>) => {
    const p = new URLSearchParams(params)
    Object.entries({ ...patch, page: patch.page ?? 1 }).forEach(([k, v]) => (v !== '' ? p.set(k, String(v)) : p.delete(k)))
    setParams(p, { replace: true })
  }
  const openCodes = d.dealStages.filter((s) => s.kind === 'open').map((s) => s.code)

  const list = useQuery({
    queryKey: ['deals', f, openCodes.join()],
    enabled: d.dealStages.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase.from('deals').select('*, location:locations(id,name,city)', { count: 'exact' })
      if (f.stage === 'open') q = q.in('stage_code', openCodes)
      else if (f.stage) q = q.eq('stage_code', f.stage)
      if (f.manager) q = q.eq('manager_id', f.manager)
      const res = await q.order('next_action_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).range((f.page - 1) * PAGE, f.page * PAGE - 1)
      if (res.error) throw res.error
      return { rows: res.data as unknown as Row[], total: res.count ?? 0 }
    },
  })
  const summary = useQuery({
    queryKey: ['deals', 'summary', f.manager],
    queryFn: async () => {
      let q = supabase.from('deals').select('stage_code, amount')
      if (f.manager) q = q.eq('manager_id', f.manager)
      const res = await q.limit(10000)
      if (res.error) throw res.error
      const m: Record<string, { count: number; amount: number }> = {}
      for (const r of res.data as { stage_code: string; amount: number | null }[]) {
        m[r.stage_code] ??= { count: 0, amount: 0 }
        m[r.stage_code].count++
        m[r.stage_code].amount += Number(r.amount ?? 0)
      }
      return m
    },
  })
  const [edit, setEdit] = useState<Row | null>(null)
  const [picking, setPicking] = useState(false)
  const [newFor, setNewFor] = useState<string | null>(null)
  const rows = list.data?.rows ?? []

  return (
    <div>
      <PageHeader title="Потенциальные сделки" subtitle="Коммерческие возможности. Предполагаемые суммы — это оценка, а не выручка."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setPicking(true)}>Новая сделка</Button>} />
      <LocationPickDialog open={picking} onClose={() => setPicking(false)} title="Сделка: выберите клиента" onPick={(id) => { setPicking(false); setNewFor(id) }} />
      <DealFormModal open={!!newFor} onClose={() => setNewFor(null)} locationId={newFor ?? ''} />
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {d.dealStages.filter((s) => s.is_active).map((s) => (
          <Stat key={s.code} label={s.name} value={summary.data?.[s.code]?.count ?? 0} hint={summary.data?.[s.code]?.amount ? fmtMoney(summary.data[s.code].amount) : undefined} onClick={() => set({ stage: s.code })} />
        ))}
      </div>
      <Card className="mb-3" bodyClassName="flex flex-wrap gap-2 p-3">
        <Select className="w-auto" value={f.stage} onChange={(e) => set({ stage: e.target.value })} aria-label="Стадия">
          <option value="open">Открытые</option><option value="">Все стадии</option>
          {d.dealStages.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </Select>
        {perms.view_team && (
          <Select className="w-auto" value={f.manager} onChange={(e) => set({ manager: e.target.value })} aria-label="Ответственный">
            <option value="">Все менеджеры</option>
            {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
          </Select>
        )}
      </Card>
      <Card bodyClassName="p-0">
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !rows.length ? (
          <EmptyState title="Сделок нет">Нажмите «Новая сделка» вверху. Сделку также можно создать из карточки клиента или по итогам визита.</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Сделка</th><th>Клиент</th><th>Сумма (оценка)</th><th>Стадия</th><th>Закрытие</th><th>Следующий шаг</th><th>Ответственный</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const st = d.dealStage(r.stage_code)
                    return (
                      <tr key={r.id} className="cursor-pointer" onClick={() => setEdit(r)}>
                        <td className="max-w-xs"><div className="font-medium text-brand-700">{r.title}</div>{r.product && <div className="text-xs text-slate-500">{r.product}</div>}</td>
                        <td>{r.location ? <Link to={`/clients/${r.location.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{r.location.name}</Link> : '—'}</td>
                        <td className="whitespace-nowrap tabular-nums">{fmtMoney(r.amount)}{r.probability != null && <span className="text-xs text-slate-500"> · {r.probability}%</span>}</td>
                        <td><Badge color={st ? KIND_COLOR[st.kind] : 'gray'}>{st?.name ?? r.stage_code}</Badge>{r.lost_reason && <div className="text-xs text-slate-500">{r.lost_reason}</div>}</td>
                        <td className="whitespace-nowrap">{fmtDate(r.expected_close_date)}</td>
                        <td className="max-w-xs">{r.next_step ?? '—'}{r.next_action_date && <div className={`text-xs ${st?.kind === 'open' && isOverdue(r.next_action_date) ? 'font-medium text-rose-600' : 'text-slate-500'}`}>{fmtDate(r.next_action_date)}</div>}</td>
                        <td>{d.profileName(r.manager_id)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={f.page} pageSize={PAGE} total={list.data?.total ?? 0} onPage={(p) => set({ page: p })} />
          </>
        )}
      </Card>
      {edit && <DealFormModal open onClose={() => setEdit(null)} locationId={edit.location_id} deal={edit} />}
    </div>
  )
}
