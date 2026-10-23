import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Plus, Route, Trash2 } from 'lucide-react'
import { Button, Card, ConfirmDialog, Field, Input, PageHeader, QueryState, Select, Stat, Tabs, Modal, Checkbox, useToast } from '@/components/ui'
import { usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtDateTime, startOfMonthISO, todayISO, plural } from '@/lib/format'
import { ROLE_LABEL } from '@/lib/labels'
import { displayLogin } from '@/lib/login'

type Tab = 'team' | 'territory' | 'history'

export default function TeamPage() {
  const perms = usePerms()
  const [tab, setTab] = useState<Tab>('team')
  if (!perms.view_team) return <Navigate to="/" replace />
  return (
    <div>
      <PageHeader title="Сотрудники и распределение клиентов" subtitle="Закрепление точек за торговыми представителями" />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ value: 'team', label: 'Команда' }, { value: 'territory', label: 'Правила по территории' }, { value: 'history', label: 'История назначений' }]} />
      <div className="mt-4">
        {tab === 'team' && <TeamTab />}
        {tab === 'territory' && <TerritoryTab />}
        {tab === 'history' && <HistoryTab />}
      </div>
    </div>
  )
}

interface AutoPlanResult {
  from: string; per_day: number; attached_near: number; no_coords: number
  reps: Record<string, { name: string; days: number; points: number; last_day: string | null; avg_km: number | null }>
}

/** Автоплан: распределение точек между торговыми и план по дням — сразу, без предпросмотра */
function AutoPlanCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const [res, setRes] = useState<AutoPlanResult | null>(null)
  const run = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('auto_plan', {})) as AutoPlanResult,
    onSuccess: (r) => {
      setRes(r)
      toast.success('План посещений перестроен')
      for (const k of [['plan'], ['clients'], ['team'], ['location'], ['dashboard']]) qc.invalidateQueries({ queryKey: k })
    },
    onError: (e) => toast.error(e),
  })
  return (
    <Card title="Автоплан посещений" className="mb-4" actions={<Button variant="primary" icon={<Route className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>Перестроить план</Button>}>
      <p className="text-sm text-slate-600">
        Точки без ответственного делятся между торговыми представителями по территориям (без пересечений), каждый день — около 15 соседних точек
        в порядке объезда. Точки в шаге (до 150 м) от запланированных ставятся в тот же день. Выходные и праздники пропускаются.
        Ручные визиты и визиты из плана сотрудника не меняются. Каждый рабочий вечер план обновляется сам: непосещённые точки переносятся.
      </p>
      {run.isPending && <p className="mt-2 text-sm text-slate-500">Считаю… это может занять до минуты.</p>}
      {res && (
        <div className="mt-3 overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Сотрудник</th><th>Дней</th><th>Точек</th><th>В среднем за день</th><th>До</th></tr></thead>
            <tbody>
              {Object.entries(res.reps).map(([id, r]) => (
                <tr key={id}><td>{r.name}</td><td>{r.days}</td><td>{r.points}</td><td>{r.avg_km != null ? `≈ ${r.avg_km} км` : '—'}</td><td>{fmtDate(r.last_day)}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-slate-500">
            С {fmtDate(res.from)}. Добавлено рядом с уже запланированными: {res.attached_near}. Без координат (не планируются): {res.no_coords} — откройте их карточки и укажите адрес.
          </p>
        </div>
      )}
    </Card>
  )
}

function TeamTab() {
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const viewAll = useMutation({
    mutationFn: async (v: { id: string; value: boolean }) => unwrap(await supabase.rpc('set_rep_view_all', { p_user: v.id, p_value: v.value })),
    onSuccess: () => { toast.success('Доступ изменён'); qc.invalidateQueries({ queryKey: ['dicts'] }) },
    onError: (e) => toast.error(e),
  })
  const autoplan = useMutation({
    mutationFn: async (v: { id: string; value: boolean }) => unwrap(await supabase.rpc('set_rep_autoplan', { p_user: v.id, p_value: v.value })),
    onSuccess: (_r, v) => { toast.success(v.value ? 'Включён в автоплан' : 'Исключён из автоплана — нажмите «Перестроить план»'); qc.invalidateQueries({ queryKey: ['dicts'] }) },
    onError: (e) => toast.error(e),
  })
  const from = startOfMonthISO()
  const to = todayISO()
  const stats = useQuery({
    queryKey: ['team', 'stats', from, to],
    queryFn: async () => {
      const [dash, mgr] = await Promise.all([
        supabase.rpc('dashboard_stats', { p_from: from, p_to: to }),
        supabase.rpc('manager_stats', { p_from: from, p_to: to }),
      ])
      return {
        dash: unwrap(dash) as { locations_total: number; locations_unassigned: number },
        mgr: unwrap(mgr) as { manager_id: string; assigned_clients: number; visits_done: number; visits_planned: number; overdue_actions: number }[],
      }
    },
  })
  const byId = new Map((stats.data?.mgr ?? []).map((m) => [m.manager_id, m]))
  const people = d.profiles.filter((p) => p.is_active)
  return (
    <QueryState query={stats}>
      <AutoPlanCard />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Всего точек" value={stats.data?.dash.locations_total ?? 0} />
        <Stat label="Без ответственного" value={stats.data?.dash.locations_unassigned ?? 0} tone={stats.data?.dash.locations_unassigned ? 'warn' : undefined} />
        <Stat label="Активных сотрудников" value={people.length} />
        <Stat label="Торговых представителей" value={people.filter((p) => p.role === 'rep').length} />
      </div>
      {!!stats.data?.dash.locations_unassigned && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          {stats.data.dash.locations_unassigned} {plural(stats.data.dash.locations_unassigned, 'точка', 'точки', 'точек')} без ответственного.
          <Link to="/clients?manager=none"><Button size="sm" variant="primary">Открыть и распределить</Button></Link>
          <span className="text-slate-600">В списке клиентов отметьте точки и нажмите «Назначить ответственного».</span>
        </div>
      )}
      <Card bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Сотрудник</th><th>Роль</th><th>Закреплено клиентов</th><th>Визитов в этом месяце (план / факт)</th><th>Просрочено действий</th><th /></tr></thead>
            <tbody>
              {people.map((p) => {
                const s = byId.get(p.id)
                return (
                  <tr key={p.id}>
                    <td><div className="font-medium">{p.full_name || '—'}</div><div className="text-xs text-slate-500">{displayLogin(p.email)}</div></td>
                    <td>
                      {ROLE_LABEL[p.role]}
                      {p.role === 'rep' && (<>
                        <div className="mt-1"><Checkbox label="Видит всю базу" checked={p.can_view_all} disabled={viewAll.isPending} onChange={(e) => viewAll.mutate({ id: p.id, value: e.target.checked })} /></div>
                        <div className="mt-1"><Checkbox label="В автоплане" checked={p.in_autoplan} disabled={autoplan.isPending} onChange={(e) => autoplan.mutate({ id: p.id, value: e.target.checked })} /></div>
                      </>)}
                    </td>
                    <td className="tabular-nums">{s?.assigned_clients ?? 0}</td>
                    <td className="tabular-nums">{s ? `${s.visits_planned} / ${s.visits_done}` : '0 / 0'}</td>
                    <td className={`tabular-nums ${Number(s?.overdue_actions) > 0 ? 'font-medium text-rose-600' : ''}`}>{s?.overdue_actions ?? 0}</td>
                    <td className="whitespace-nowrap">
                      <Link to={`/clients?manager=${p.id}`} className="mr-3 text-sm text-brand-700 hover:underline">Клиенты</Link>
                      <Link to={`/plan?manager=${p.id}`} className="text-sm text-brand-700 hover:underline">План</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </QueryState>
  )
}

interface Rule { id: string; city: string; district: string | null; manager_id: string; is_active: boolean; created_at: string }
interface PreviewRow { location_id: string; location_name: string; city: string; district: string | null; current_manager_id: string | null; new_manager_id: string }

function TerritoryTab() {
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const [city, setCity] = useState('')
  const [district, setDistrict] = useState('')
  const [manager, setManager] = useState('')
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [onlyUnassigned, setOnlyUnassigned] = useState(true)
  const [reason, setReason] = useState('')

  const rules = useQuery({ queryKey: ['territory-rules'], queryFn: async () => unwrap(await supabase.from('territory_rules').select('*').order('city').order('district')) as Rule[] })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['territory-rules'] })
  const add = useMutation({
    mutationFn: async () => unwrap(await supabase.from('territory_rules').insert({ city: city.trim(), district: district.trim() || null, manager_id: manager }).select('id')),
    onSuccess: () => { toast.success('Правило добавлено'); setCity(''); setDistrict(''); setManager(''); invalidate() },
    onError: (e) => toast.error(e),
  })
  const toggle = useMutation({
    mutationFn: async (r: Rule) => unwrap(await supabase.from('territory_rules').update({ is_active: !r.is_active }).eq('id', r.id).select('id')),
    onSuccess: invalidate,
    onError: (e) => toast.error(e),
  })
  const remove = useMutation({
    mutationFn: async (r: Rule) => unwrap(await supabase.from('territory_rules').delete().eq('id', r.id).select('id')),
    onSuccess: () => { toast.success('Правило удалено'); setDeleting(null); invalidate() },
    onError: (e) => toast.error(e),
  })
  const loadPreview = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('territory_preview', { p_only_unassigned: onlyUnassigned })) as PreviewRow[],
    onSuccess: setPreview,
    onError: (e) => toast.error(e),
  })
  const apply = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('territory_apply', { p_only_unassigned: onlyUnassigned, p_reason: reason || null })) as number,
    onSuccess: (n) => {
      toast.success(`Назначено клиентов: ${n}`)
      setPreview(null)
      qc.invalidateQueries({ queryKey: ['clients'] })
      qc.invalidateQueries({ queryKey: ['team'] })
    },
    onError: (e) => toast.error(e),
  })

  const summary = new Map<string, number>()
  for (const p of preview ?? []) summary.set(p.new_manager_id, (summary.get(p.new_manager_id) ?? 0) + 1)

  return (
    <div className="space-y-4">
      <Card title="Правила">
        <p className="mb-3 text-sm text-slate-600">Правило связывает город (и, при желании, район) с сотрудником. Правила <b>не применяются автоматически</b> — только кнопкой «Применить» после предпросмотра.</p>
        <form onSubmit={(e) => { e.preventDefault(); if (city.trim() && manager) add.mutate() }} className="mb-4 grid gap-2 sm:grid-cols-4">
          <Input placeholder="Город" value={city} onChange={(e) => setCity(e.target.value)} aria-label="Город" />
          <Input placeholder="Район (необязательно)" value={district} onChange={(e) => setDistrict(e.target.value)} aria-label="Район" />
          <Select value={manager} onChange={(e) => setManager(e.target.value)} aria-label="Сотрудник">
            <option value="">Сотрудник…</option>
            {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
          </Select>
          <Button type="submit" variant="primary" icon={<Plus className="size-4" />} disabled={!city.trim() || !manager} loading={add.isPending}>Добавить правило</Button>
        </form>
        <QueryState query={rules} empty={!rules.data?.length} emptyTitle="Правил пока нет">
          <ul className="divide-y divide-slate-100">
            {rules.data?.map((r) => (
              <li key={r.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 text-sm ${r.is_active ? '' : 'opacity-50'}`}>
                <span><b>{r.city}</b>{r.district ? `, ${r.district}` : ' (весь город)'} → {d.profileName(r.manager_id)}</span>
                <span className="flex items-center gap-2">
                  <Checkbox label="Активно" checked={r.is_active} onChange={() => toggle.mutate(r)} />
                  <Button size="sm" variant="ghost" aria-label="Удалить правило" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(r)} />
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
      </Card>

      <Card title="Применить правила">
        <div className="flex flex-wrap items-center gap-3">
          <Checkbox label="Только точки без ответственного" checked={onlyUnassigned} onChange={(e) => { setOnlyUnassigned(e.target.checked); setPreview(null) }} />
          <Button icon={<Eye className="size-4" />} loading={loadPreview.isPending} onClick={() => loadPreview.mutate()}>Предпросмотр</Button>
        </div>
      </Card>

      <Modal open={!!preview} onClose={() => setPreview(null)} size="lg" title="Предпросмотр распределения" dismissable={!apply.isPending}
        footer={<><Button onClick={() => setPreview(null)} disabled={apply.isPending}>Отмена</Button><Button variant="primary" disabled={!preview?.length} loading={apply.isPending} onClick={() => apply.mutate()}>Применить ({preview?.length ?? 0})</Button></>}>
        {!preview?.length ? <p className="text-sm text-slate-600">Нет точек, к которым применимы активные правила.</p> : (
          <div className="space-y-3">
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              <p className="font-medium">Будет назначено: {preview.length}</p>
              <ul className="mt-1">{[...summary.entries()].map(([id, n]) => <li key={id}>{d.profileName(id)} — {n}</li>)}</ul>
            </div>
            <Field label="Причина (для истории)">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Правило территории" />}</Field>
            <div className="max-h-72 overflow-y-auto">
              <table className="data-table">
                <thead><tr><th>Точка</th><th>Город / район</th><th>Сейчас</th><th>Станет</th></tr></thead>
                <tbody>{preview.slice(0, 500).map((p) => (
                  <tr key={p.location_id}><td>{p.location_name}</td><td>{[p.city, p.district].filter(Boolean).join(', ')}</td><td>{p.current_manager_id ? d.profileName(p.current_manager_id) : '—'}</td><td>{d.profileName(p.new_manager_id)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>
      <ConfirmDialog open={!!deleting} title="Удалить правило?" danger confirmText="Удалить" loading={remove.isPending} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting)}>
        Уже назначенные клиенты останутся за сотрудниками.
      </ConfirmDialog>
    </div>
  )
}

function HistoryTab() {
  const d = useDicts()
  const q = useQuery({
    queryKey: ['team', 'assign-history'],
    queryFn: async () => unwrap(await supabase.from('manager_assignments').select('*, location:locations(id,name,city)').order('created_at', { ascending: false }).limit(200)) as
      { id: string; from_manager_id: string | null; to_manager_id: string | null; reason: string | null; assigned_by: string | null; created_at: string; location: { id: string; name: string; city: string | null } | null }[],
  })
  return (
    <Card bodyClassName="p-0">
      <QueryState query={q} empty={!q.data?.length} emptyTitle="Назначений ещё не было">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr><th>Когда</th><th>Точка</th><th>Было</th><th>Стало</th><th>Кто назначил</th><th>Причина</th></tr></thead>
            <tbody>
              {q.data?.map((a) => (
                <tr key={a.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(a.created_at)}</td>
                  <td>{a.location ? <Link to={`/clients/${a.location.id}`} className="text-brand-700 hover:underline">{a.location.name}</Link> : '—'}</td>
                  <td>{a.from_manager_id ? d.profileName(a.from_manager_id) : '—'}</td>
                  <td>{a.to_manager_id ? d.profileName(a.to_manager_id) : 'Без ответственного'}</td>
                  <td>{a.assigned_by ? d.profileName(a.assigned_by) : 'Система'}</td>
                  <td>{a.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </Card>
  )
}
