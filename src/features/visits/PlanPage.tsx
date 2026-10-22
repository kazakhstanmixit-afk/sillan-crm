import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, CalendarX, CheckCircle2, ChevronLeft, ChevronRight, MapPin, MoreHorizontal, Pencil, Phone, Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, PageHeader, QueryState, Select, Textarea, useToast } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtDateTime, mapHref, parseDateOnly, toISODate, todayISO } from '@/lib/format'
import { formatPhone, telHref } from '@/lib/phone'
import { INTEREST_LABEL, VISIT_STATUS_COLOR, VISIT_STATUS_LABEL } from '@/lib/labels'
import { fetchPlan, type PlanVisit } from './api'
import { AddPointsDialog } from './AddPointsDialog'
import { VisitResultDialog } from './VisitResultDialog'
import { VisitEditDialog, VisitStatusDialog, type StatusAction } from './VisitStatusDialog'

const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' })

export default function PlanPage() {
  const { session } = useAuth()
  const perms = usePerms()
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const date = params.get('date') || todayISO()
  const manager = (perms.view_team && params.get('manager')) || session!.user.id
  const setParam = (k: string, v: string) => { const p = new URLSearchParams(params); p.set(k, v); setParams(p, { replace: true }) }
  const shiftDate = (n: number) => { const x = parseDateOnly(date); x.setDate(x.getDate() + n); setParam('date', toISODate(x)) }

  const key = ['plan', manager, date]
  const q = useQuery({ queryKey: key, queryFn: () => fetchPlan(manager, date) })
  const visits = useMemo(() => q.data?.visits ?? [], [q.data])
  const canManage = manager === session!.user.id || perms.edit_all

  // порядок точек: локально сразу, в базе — сохраняется вызовом reorder_plan_visits
  const [order, setOrder] = useState<string[]>([])
  useEffect(() => setOrder(visits.map((v) => v.id)), [visits])
  const ordered = order.map((id) => visits.find((v) => v.id === id)).filter(Boolean) as PlanVisit[]
  const reorder = useMutation({
    mutationFn: async (ids: string[]) => unwrap(await supabase.rpc('reorder_plan_visits', { p_plan: q.data!.plan!.id, p_ids: ids })),
    onError: (e) => { toast.error(e); setOrder(visits.map((v) => v.id)) },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
  const move = (i: number, dir: -1 | 1) => {
    const next = [...order]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setOrder(next)
    reorder.mutate(next)
  }

  const [notes, setNotes] = useState('')
  useEffect(() => setNotes(q.data?.plan?.notes ?? ''), [q.data?.plan?.notes])
  const saveNotes = useMutation({
    mutationFn: async () => unwrap(await supabase.from('visit_plans').update({ notes: notes.trim() || null }).eq('id', q.data!.plan!.id).select('id')),
    onSuccess: () => { toast.success('Заметки к плану сохранены'); qc.invalidateQueries({ queryKey: key }) },
    onError: (e) => toast.error(e),
  })

  const remove = useMutation({
    mutationFn: async (v: PlanVisit) => {
      const rows = unwrap(await supabase.from('visits').delete().eq('id', v.id).select('id'))
      if (!rows?.length) throw new Error('Убрать можно только не проведённый визит без результата')
    },
    onSuccess: () => { toast.success('Точка убрана из плана'); setRemoving(null); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['location'] }) },
    onError: (e) => toast.error(e),
  })

  const [addOpen, setAddOpen] = useState(false)
  const [resultFor, setResultFor] = useState<PlanVisit | null>(null)
  const [statusFor, setStatusFor] = useState<{ v: PlanVisit; action: StatusAction } | null>(null)
  const [editFor, setEditFor] = useState<PlanVisit | null>(null)
  const [removing, setRemoving] = useState<PlanVisit | null>(null)
  const [menu, setMenu] = useState<string | null>(null)

  const done = visits.filter((v) => v.status === 'done').length
  const planned = visits.filter((v) => v.status === 'planned').length

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="План посещений"
        subtitle="Список точек на день в нужном порядке. Встроенной карты и расчёта маршрута нет — адрес открывается во внешнем приложении."
        actions={canManage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAddOpen(true)}>Добавить точки</Button>}
      />
      <Card className="mb-3" bodyClassName="flex flex-wrap items-center gap-2 p-3">
        <Button size="sm" variant="ghost" aria-label="Предыдущий день" onClick={() => shiftDate(-1)}><ChevronLeft className="size-4" /></Button>
        <Input type="date" value={date} onChange={(e) => e.target.value && setParam('date', e.target.value)} className="w-auto" aria-label="Дата плана" />
        <Button size="sm" variant="ghost" aria-label="Следующий день" onClick={() => shiftDate(1)}><ChevronRight className="size-4" /></Button>
        <span className="text-sm capitalize text-slate-600">{weekday.format(parseDateOnly(date))}</span>
        {date !== todayISO() && <Button size="sm" variant="ghost" onClick={() => setParam('date', todayISO())}>Сегодня</Button>}
        {perms.view_team && (
          <Select className="ml-auto w-auto min-w-52" value={manager} onChange={(e) => setParam('manager', e.target.value)} aria-label="Сотрудник">
            {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}{p.id === session!.user.id ? ' (я)' : ''}</option>)}
          </Select>
        )}
      </Card>

      <QueryState query={q}>
        {!visits.length ? (
          <Card>
            <EmptyState title={`На ${fmtDate(date)} визитов не запланировано`}>
              {canManage ? 'Нажмите «Добавить точки» или запланируйте визит из карточки клиента.' : 'У сотрудника нет плана на этот день.'}
            </EmptyState>
          </Card>
        ) : (
          <>
            <p className="mb-2 text-sm text-slate-600">Всего точек: {visits.length} · выполнено: {done} · осталось: {planned}</p>
            <ol className="space-y-2">
              {ordered.map((v, i) => {
                const loc = v.location
                const address = loc?.confirmed_address ?? loc?.source_address
                const map = loc ? mapHref({ lat: loc.lat, lng: loc.lng, address, city: loc.city }) : null
                const contact = q.data?.contacts[v.location_id]
                const phone = contact?.phone ?? loc?.phones?.[0]
                const isPlanned = v.status === 'planned'
                return (
                  <li key={v.id} className={`rounded-lg border bg-white p-3 ${v.status === 'done' ? 'border-emerald-200' : 'border-slate-200'}`}>
                    <div className="flex items-start gap-3">
                      <div className="flex flex-col items-center">
                        <span className="flex size-7 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-800">{i + 1}</span>
                        {canManage && (
                          <div className="mt-1 flex flex-col">
                            <button className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)} aria-label="Выше"><ArrowUp className="size-4" /></button>
                            <button className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" disabled={i === ordered.length - 1 || reorder.isPending} onClick={() => move(i, 1)} aria-label="Ниже"><ArrowDown className="size-4" /></button>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link to={`/clients/${v.location_id}`} className="font-medium text-slate-900 hover:text-brand-700 hover:underline">{loc?.name ?? 'Клиент недоступен'}</Link>
                          <Badge color={VISIT_STATUS_COLOR[v.status]}>{VISIT_STATUS_LABEL[v.status]}</Badge>
                          {v.interest && <Badge color="violet">Интерес: {INTEREST_LABEL[v.interest]}</Badge>}
                        </div>
                        {address && <div className="text-sm text-slate-600">{[loc?.city, address].filter(Boolean).join(', ')}</div>}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                          {contact?.full_name && <span className="text-slate-600">{contact.full_name}</span>}
                          {phone && <a href={telHref(phone)} className="inline-flex items-center gap-1 text-brand-700"><Phone className="size-3.5" />{formatPhone(phone)}</a>}
                          {map && <a href={map} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700"><MapPin className="size-3.5" />Открыть адрес</a>}
                        </div>
                        {v.purpose && <div className="text-sm"><span className="text-slate-500">Цель:</span> {v.purpose}</div>}
                        {v.prep_notes && <div className="whitespace-pre-line text-sm text-slate-600">{v.prep_notes}</div>}
                        {v.status === 'done' && (
                          <div className="rounded bg-emerald-50 px-2 py-1.5 text-sm text-emerald-900">
                            <span className="text-xs text-emerald-700">{fmtDateTime(v.actual_at)}</span> {v.result}
                            {v.next_step && <div className="text-xs">Следующий шаг: {v.next_step}</div>}
                          </div>
                        )}
                        {v.status_reason && v.status !== 'done' && <div className="text-xs text-slate-500">Причина: {v.status_reason}</div>}
                      </div>
                      {canManage && (
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {(isPlanned || v.status === 'done' || v.status === 'failed') && (
                            <Button size="sm" variant={isPlanned ? 'primary' : 'secondary'} icon={<CheckCircle2 className="size-3.5" />} onClick={() => setResultFor(v)}>
                              {isPlanned ? 'Результат' : 'Изменить'}
                            </Button>
                          )}
                          <div className="relative">
                            <Button size="sm" variant="ghost" aria-label="Ещё действия" onClick={() => setMenu(menu === v.id ? null : v.id)}><MoreHorizontal className="size-4" /></Button>
                            {menu === v.id && (
                              <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg" onMouseLeave={() => setMenu(null)}>
                                {isPlanned && <MenuItem icon={<Pencil className="size-3.5" />} onClick={() => { setEditFor(v); setMenu(null) }}>Цель и подготовка</MenuItem>}
                                {isPlanned && <MenuItem icon={<CalendarX className="size-3.5" />} onClick={() => { setStatusFor({ v, action: 'rescheduled' }); setMenu(null) }}>Перенести</MenuItem>}
                                {isPlanned && <MenuItem onClick={() => { setStatusFor({ v, action: 'failed' }); setMenu(null) }}>Не состоялся</MenuItem>}
                                {isPlanned && <MenuItem onClick={() => { setStatusFor({ v, action: 'cancelled' }); setMenu(null) }}>Отменить</MenuItem>}
                                {(v.status === 'cancelled' || v.status === 'failed') && <MenuItem onClick={() => { setStatusFor({ v, action: 'planned' }); setMenu(null) }}>Вернуть в план</MenuItem>}
                                {isPlanned && !v.result && <MenuItem danger icon={<Trash2 className="size-3.5" />} onClick={() => { setRemoving(v); setMenu(null) }}>Убрать из плана</MenuItem>}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </>
        )}
        {q.data?.plan && (
          <Card title="Заметки к плану" className="mt-4">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canManage} rows={2} aria-label="Заметки к плану" maxLength={3000} />
            {canManage && notes !== (q.data.plan.notes ?? '') && (
              <div className="mt-2 flex justify-end"><Button size="sm" variant="primary" loading={saveNotes.isPending} onClick={() => saveNotes.mutate()}>Сохранить заметки</Button></div>
            )}
          </Card>
        )}
      </QueryState>

      <AddPointsDialog open={addOpen} onClose={() => setAddOpen(false)} managerId={manager} date={date} existing={visits.filter((v) => ['planned', 'done', 'failed'].includes(v.status)).map((v) => v.location_id)} onlyOwn={!perms.view_all} />
      {resultFor && <VisitResultDialog visit={resultFor} locationName={resultFor.location?.name ?? ''} onClose={() => setResultFor(null)} />}
      {statusFor && <VisitStatusDialog visit={statusFor.v} action={statusFor.action} onClose={() => setStatusFor(null)} />}
      {editFor && <VisitEditDialog visit={editFor} onClose={() => setEditFor(null)} />}
      <ConfirmDialog open={!!removing} title="Убрать точку из плана?" loading={remove.isPending} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} confirmText="Убрать">
        «{removing?.location?.name}» будет убрана из плана на {fmtDate(date)}. Если визит не состоялся — лучше отметить «Не состоялся» или «Перенести», чтобы это осталось в истории.
      </ConfirmDialog>
    </div>
  )
}

function MenuItem({ children, onClick, icon, danger }: { children: React.ReactNode; onClick: () => void; icon?: React.ReactNode; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-50 ${danger ? 'text-rose-600' : 'text-slate-700'}`}>
      {icon ?? <span className="size-3.5" />}{children}
    </button>
  )
}
