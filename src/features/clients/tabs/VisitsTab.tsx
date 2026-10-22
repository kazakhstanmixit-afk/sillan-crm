import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CalendarPlus } from 'lucide-react'
import { Badge, Button, Card, QueryState } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { INTEREST_LABEL, VISIT_STATUS_COLOR, VISIT_STATUS_LABEL } from '@/lib/labels'
import type { Visit } from '@/lib/types'
import { VisitDetails } from '@/features/visits/VisitDetails'
import { VisitResultDialog } from '@/features/visits/VisitResultDialog'
import { clientKeys } from '../api'

export function VisitsTab({ locationId, onPlan }: { locationId: string; onPlan: () => void }) {
  const d = useDicts()
  const perms = usePerms()
  const { session } = useAuth()
  const [open, setOpen] = useState<Visit | null>(null)
  const [edit, setEdit] = useState<Visit | null>(null)
  const q = useQuery({
    queryKey: clientKeys(locationId).visits,
    queryFn: async () => unwrap(await supabase.from('visits').select('*').eq('location_id', locationId).order('planned_date', { ascending: false }).limit(200)) as Visit[],
  })
  return (
    <Card title="Визиты" actions={<Button size="sm" variant="primary" icon={<CalendarPlus className="size-3.5" />} onClick={onPlan}>Запланировать визит</Button>}>
      <QueryState query={q} empty={!q.data?.length} emptyTitle="Визитов ещё не было">
        <ul className="divide-y divide-slate-100">
          {q.data?.map((v) => (
            <li key={v.id}>
              <button className="w-full py-2.5 text-left hover:bg-slate-50" onClick={() => setOpen(v)}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{fmtDate(v.planned_date)}</span>
                  <Badge color={VISIT_STATUS_COLOR[v.status]}>{VISIT_STATUS_LABEL[v.status]}</Badge>
                  <span className="text-slate-500">{d.profileName(v.manager_id)}</span>
                  {v.actual_at && <span className="text-xs text-slate-400">факт: {fmtDateTime(v.actual_at)}</span>}
                  {v.interest && <Badge color="violet">Интерес: {INTEREST_LABEL[v.interest]}</Badge>}
                  {v.status === 'planned' && <Link onClick={(e) => e.stopPropagation()} to={`/plan?date=${v.planned_date}${v.manager_id !== session?.user.id ? `&manager=${v.manager_id}` : ''}`} className="text-xs text-brand-700 underline">открыть план</Link>}
                </div>
                {(v.result || v.purpose) && <p className="mt-0.5 line-clamp-2 text-sm text-slate-700">{v.result || `Цель: ${v.purpose}`}</p>}
                {v.next_step && <p className="text-xs text-slate-500">Следующий шаг: {v.next_step}</p>}
              </button>
            </li>
          ))}
        </ul>
      </QueryState>
      {open && (
        <VisitDetails visit={open} locationName="" onClose={() => setOpen(null)}
          onEdit={(open.manager_id === session?.user.id || perms.edit_all) && ['planned', 'done', 'failed'].includes(open.status) ? () => { setEdit(open); setOpen(null) } : undefined} />
      )}
      {edit && <VisitResultDialog visit={edit} locationName="" onClose={() => setEdit(null)} />}
    </Card>
  )
}
