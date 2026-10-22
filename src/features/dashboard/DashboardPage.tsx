import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BarList, Card, EmptyState, PageHeader, QueryState, Stat, Badge } from '@/components/ui'
import { PeriodFilters, type PeriodState } from '@/components/PeriodFilters'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtNumber, startOfMonthISO, todayISO } from '@/lib/format'
import { fetchFilterOptions } from '@/features/clients/api'
import { URGENCY_COLOR, URGENCY_LABEL } from '@/lib/labels'

export interface DashboardStats {
  companies_total: number
  locations_total: number
  locations_new: number
  locations_unassigned: number
  by_direction: { id: string; name: string; count: number }[]
  without_direction: number
  by_city: { name: string; count: number }[]
  by_manager: { id: string | null; name: string; count: number }[]
  visits_today: number
  visits_done: number
  visits_planned_period: number
  overdue_visits: number
  overdue_contacts: number
  overdue_deals: number
  requests_new: number
  requests_in_work: number
  requests_created_period: number
  deals_open: number
  deals_open_amount: number
  deals_by_stage: { code: string; name: string; kind: string; count: number; amount: number }[]
}

export function useDashboard(p: PeriodState) {
  return useQuery({
    queryKey: ['dashboard', p],
    queryFn: async () => unwrap(await supabase.rpc('dashboard_stats', {
      p_from: p.from, p_to: p.to, p_manager: p.manager || null, p_city: p.city || null, p_direction: p.direction || null,
    })) as DashboardStats,
  })
}

export default function DashboardPage() {
  const { profile, session } = useAuth()
  const perms = usePerms()
  const nav = useNavigate()
  const [p, setP] = useState<PeriodState>({ from: startOfMonthISO(), to: todayISO(), manager: '', city: '', direction: '' })
  const stats = useDashboard(p)
  const options = useQuery({ queryKey: ['clients', 'options'], queryFn: fetchFilterOptions, staleTime: 5 * 60_000 })
  const today = useQuery({
    queryKey: ['plan', 'today-short', session?.user.id],
    queryFn: async () => unwrap(await supabase.from('visits').select('id, status, location:locations(id,name,city)').eq('manager_id', session!.user.id).eq('planned_date', todayISO()).order('position')) as unknown as { id: string; status: string; location: { id: string; name: string; city: string | null } | null }[],
  })
  const newRequests = useQuery({
    queryKey: ['requests', 'new-short'],
    queryFn: async () => unwrap(await supabase.from('requests').select('id, number, item_name, urgency, created_at, location:locations(name)').eq('status_code', 'new').order('created_at', { ascending: false }).limit(6)) as unknown as { id: string; number: string; item_name: string; urgency: string; created_at: string; location: { name: string } | null }[],
  })
  const s = stats.data

  return (
    <div className="space-y-4">
      <PageHeader title={`Здравствуйте${profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`} subtitle={perms.view_team ? 'Показатели по всей команде' : 'Показатели по вашим клиентам'} />
      <Card bodyClassName="p-3"><PeriodFilters value={p} onChange={setP} cities={options.data?.cities ?? []} /></Card>

      <QueryState query={stats}>
        {s && (
          <>
            {s.locations_total === 0 && (
              <Card>
                <EmptyState title="В базе пока нет клиентов">
                  {perms.import ? <>Загрузите выгрузку 2GIS в разделе <Link to="/import" className="text-brand-700 underline">«Импорт данных»</Link> или добавьте клиента вручную.</> : <>Добавьте клиента вручную или попросите руководителя закрепить за вами точки.</>}
                </EmptyState>
              </Card>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Организаций (юрлиц)" value={fmtNumber(s.companies_total)} />
              <Stat label="Точек обслуживания" value={fmtNumber(s.locations_total)} onClick={() => nav('/clients')} />
              <Stat label="Новых точек за период" value={fmtNumber(s.locations_new)} />
              <Stat label="Без ответственного" value={fmtNumber(s.locations_unassigned)} tone={s.locations_unassigned ? 'warn' : undefined} onClick={perms.view_all ? () => nav('/clients?manager=none') : undefined} />
              <Stat label="Визитов на сегодня" value={s.visits_today} onClick={() => nav('/plan')} />
              <Stat label="Выполнено визитов" value={s.visits_done} hint={`запланировано на период: ${s.visits_planned_period}`} />
              <Stat label="Просрочено визитов" value={s.overdue_visits} tone={s.overdue_visits ? 'warn' : undefined} hint="Запланированы на прошедшие даты" />
              <Stat label="Просрочено контактов" value={s.overdue_contacts} tone={s.overdue_contacts ? 'warn' : undefined} hint="Дата следующего контакта прошла" />
              <Stat label="Новых заявок" value={s.requests_new} onClick={() => nav('/requests?status=new')} />
              <Stat label="Заявок в работе" value={s.requests_in_work} onClick={() => nav('/requests')} />
              <Stat label="Заявок за период" value={s.requests_created_period} onClick={() => nav('/requests?status=')} />
            </div>

            <div className={`grid gap-4 ${perms.view_team ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
              <Card title="Точки по направлениям">
                <BarList items={[...s.by_direction.map((x) => ({ label: x.name, value: x.count, onClick: () => nav(`/clients?direction=${x.id}`) })), ...(s.without_direction ? [{ label: 'Направление не указано', value: s.without_direction }] : [])]} />
                <p className="mt-2 text-xs text-slate-400">Одна точка может относиться к нескольким направлениям.</p>
              </Card>
              <Card title="Точки по городам">
                <BarList items={s.by_city.map((x) => ({ label: x.name, value: x.count, onClick: x.name !== 'Не указан' ? () => nav(`/clients?city=${encodeURIComponent(x.name)}`) : undefined }))} />
              </Card>
              {perms.view_team && (
                <Card title="Точки по менеджерам">
                  <BarList items={s.by_manager.map((x) => ({ label: x.name, value: x.count, onClick: () => nav(`/clients?manager=${x.id ?? 'none'}`) }))} />
                </Card>
              )}
            </div>
          </>
        )}
      </QueryState>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Мои визиты на сегодня" actions={<Link to="/plan" className="text-sm text-brand-700 hover:underline">Открыть план</Link>}>
          <QueryState query={today} empty={!today.data?.length} emptyTitle="На сегодня визитов нет">
            <ol className="space-y-1 text-sm">
              {today.data?.map((v, i) => (
                <li key={v.id} className="flex items-center gap-2">
                  <span className="w-5 text-right text-slate-400">{i + 1}.</span>
                  <Link to={`/clients/${v.location?.id}`} className="hover:underline">{v.location?.name}</Link>
                  <span className="text-slate-500">{v.location?.city}</span>
                  {v.status !== 'planned' && <Badge color={v.status === 'done' ? 'green' : 'gray'}>{v.status === 'done' ? 'выполнен' : 'закрыт'}</Badge>}
                </li>
              ))}
            </ol>
          </QueryState>
        </Card>
        <Card title="Новые заявки" actions={<Link to="/requests?status=new" className="text-sm text-brand-700 hover:underline">Все</Link>}>
          <QueryState query={newRequests} empty={!newRequests.data?.length} emptyTitle="Новых заявок нет">
            <ul className="space-y-1.5 text-sm">
              {newRequests.data?.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <Link to={`/requests/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.number}</Link>
                  <span className="truncate">{r.item_name}</span>
                  <span className="text-slate-500">· {r.location?.name} · {fmtDate(r.created_at)}</span>
                  {r.urgency !== 'normal' && <Badge color={URGENCY_COLOR[r.urgency]}>{URGENCY_LABEL[r.urgency]}</Badge>}
                </li>
              ))}
            </ul>
          </QueryState>
        </Card>
      </div>
    </div>
  )
}
