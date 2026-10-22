import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { Badge, Button, Card, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner, useToast } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtMoney, todayISO } from '@/lib/format'
import { exportCsv } from '@/lib/export'
import { REQUEST_KIND_LABEL, URGENCY_COLOR, URGENCY_LABEL } from '@/lib/labels'
import type { Request } from '@/lib/types'

type Row = Request & { location: { id: string; name: string; city: string | null } | null }
const PAGE = 50

export default function RequestsPage() {
  const [params, setParams] = useSearchParams()
  const d = useDicts()
  const perms = usePerms()
  const { session } = useAuth()
  const toast = useToast()
  const f = {
    kind: params.get('kind') ?? '',
    status: params.get('status') ?? 'open',
    scope: params.get('scope') ?? '',
    q: params.get('q') ?? '',
    page: Number(params.get('page') ?? 1),
  }
  const set = (patch: Partial<typeof f>) => {
    const p = new URLSearchParams(params)
    Object.entries({ ...patch, page: patch.page ?? 1 }).forEach(([k, v]) => (v !== '' && v !== undefined ? p.set(k, String(v)) : p.delete(k)))
    setParams(p, { replace: true })
  }
  const finals = d.requestStatuses.filter((s) => s.is_final).map((s) => s.code)

  const build = useMemo(() => () => {
    let q = supabase.from('requests').select('*, location:locations(id,name,city)', { count: 'exact' })
    if (f.kind) q = q.eq('kind', f.kind)
    if (f.status === 'open') q = finals.length ? q.not('status_code', 'in', `(${finals.join(',')})`) : q
    else if (f.status) q = q.eq('status_code', f.status)
    if (f.scope === 'mine') q = q.eq('initiator_id', session!.user.id)
    if (f.scope === 'assigned') q = q.eq('assignee_id', session!.user.id)
    if (f.q.trim()) {
      const s = f.q.trim().replace(/[,()%_\\]/g, ' ')
      q = q.or(`number.ilike.%${s}%,item_name.ilike.%${s}%,article.ilike.%${s}%`)
    }
    return q.order('created_at', { ascending: false })
  }, [f.kind, f.status, f.scope, f.q, finals.join(), session])

  const list = useQuery({
    queryKey: ['requests', f, finals.join()],
    placeholderData: keepPreviousData,
    enabled: d.requestStatuses.length > 0,
    queryFn: async () => {
      const res = await build().range((f.page - 1) * PAGE, f.page * PAGE - 1)
      if (res.error) throw res.error
      return { rows: res.data as unknown as Row[], total: res.count ?? 0 }
    },
  })
  const [exporting, setExporting] = useState(false)
  const doExport = async () => {
    setExporting(true)
    try {
      const rows: Row[] = []
      for (let from = 0; from < 20000; from += 1000) {
        const part = unwrap(await build().range(from, from + 999)) as unknown as Row[]
        rows.push(...part)
        if (part.length < 1000) break
      }
      exportCsv(rows, [
        { header: 'Номер', value: (r) => r.number },
        { header: 'Отдел', value: (r) => REQUEST_KIND_LABEL[r.kind] },
        { header: 'Дата', value: (r) => fmtDate(r.created_at) },
        { header: 'Клиент', value: (r) => r.location?.name ?? '' },
        { header: 'Что требуется', value: (r) => r.item_name },
        { header: 'Бренд', value: (r) => r.brand ?? '' },
        { header: 'Модель / артикул', value: (r) => r.model ?? r.article ?? '' },
        { header: 'Кол-во', value: (r) => r.quantity },
        { header: 'Бюджет', value: (r) => r.budget ?? '' },
        { header: 'Срочность', value: (r) => URGENCY_LABEL[r.urgency] },
        { header: 'Статус', value: (r) => d.requestStatus(r.status_code)?.name ?? r.status_code },
        { header: 'Инициатор', value: (r) => d.profileName(r.initiator_id) },
        { header: 'Ответственный', value: (r) => (r.assignee_id ? d.profileName(r.assignee_id) : r.assignee_name ?? '') },
      ], `requests_${todayISO()}.csv`)
    } catch (e) {
      toast.error(e)
    } finally {
      setExporting(false)
    }
  }

  const rows = list.data?.rows ?? []
  return (
    <div>
      <PageHeader title="Заявки" subtitle="Заявки в отдел оборудования и отдел запчастей. Новая заявка создаётся из карточки клиента или результата визита."
        actions={<Button icon={<Download className="size-4" />} loading={exporting} disabled={!list.data?.total} onClick={doExport}>CSV</Button>} />
      <Card className="mb-3" bodyClassName="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
        <Input className="col-span-2 sm:col-span-1" placeholder="№, название, артикул" defaultValue={f.q} onKeyDown={(e) => e.key === 'Enter' && set({ q: (e.target as HTMLInputElement).value })} onBlur={(e) => e.target.value !== f.q && set({ q: e.target.value })} aria-label="Поиск заявок" />
        <Select value={f.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Отдел">
          <option value="">Оба отдела</option><option value="equipment">Оборудование</option><option value="parts">Запчасти</option>
        </Select>
        <Select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="Статус">
          <option value="open">Открытые</option><option value="">Все статусы</option>
          {d.requestStatuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </Select>
        <Select value={f.scope} onChange={(e) => set({ scope: e.target.value })} aria-label="Чьи">
          <option value="">{perms.view_team ? 'Все доступные' : 'Все мои и по моим клиентам'}</option>
          <option value="mine">Созданы мной</option><option value="assigned">Назначены мне</option>
        </Select>
      </Card>
      <Card bodyClassName="p-0">
        {list.isLoading ? <Spinner /> : list.error ? <div className="p-4"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div> : !rows.length ? (
          <EmptyState title="Заявок нет">Заявки создаются из карточки клиента (кнопка «Заявка») или из результата визита.</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>Номер</th><th>Дата</th><th>Клиент</th><th>Что требуется</th><th>Кол-во</th><th>Бюджет</th><th>Срочность</th><th>Статус</th><th>Ответственный</th></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const st = d.requestStatus(r.status_code)
                    return (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap"><Link to={`/requests/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.number}</Link><div className="text-xs text-slate-500">{REQUEST_KIND_LABEL[r.kind]}</div></td>
                        <td className="whitespace-nowrap">{fmtDate(r.created_at)}</td>
                        <td>{r.location ? <Link to={`/clients/${r.location.id}`} className="hover:underline">{r.location.name}</Link> : '—'}</td>
                        <td className="max-w-xs">{r.item_name}<div className="text-xs text-slate-500">{[r.brand, r.model, r.article].filter(Boolean).join(' · ')}</div></td>
                        <td className="tabular-nums">{r.quantity}</td>
                        <td className="whitespace-nowrap">{r.budget ? fmtMoney(r.budget) : '—'}</td>
                        <td><Badge color={URGENCY_COLOR[r.urgency]}>{URGENCY_LABEL[r.urgency]}</Badge></td>
                        <td><Badge color={st?.color}>{st?.name ?? r.status_code}</Badge></td>
                        <td>{r.assignee_id ? d.profileName(r.assignee_id) : r.assignee_name ?? <span className="text-slate-400">—</span>}</td>
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
    </div>
  )
}
