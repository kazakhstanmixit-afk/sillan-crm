import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Briefcase, ClipboardList } from 'lucide-react'
import { Badge, Button, Card, QueryState } from '@/components/ui'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtMoney } from '@/lib/format'
import { REQUEST_KIND_LABEL } from '@/lib/labels'
import type { Deal, Request } from '@/lib/types'
import { DealFormModal } from '@/features/deals/DealFormModal'
import { clientKeys } from '../api'

export function SalesTab({ locationId, onNewRequest, onNewDeal }: { locationId: string; onNewRequest: () => void; onNewDeal: () => void }) {
  const d = useDicts()
  const keys = clientKeys(locationId)
  const [edit, setEdit] = useState<Deal | null>(null)
  const requests = useQuery({
    queryKey: keys.requests,
    queryFn: async () => unwrap(await supabase.from('requests').select('*').eq('location_id', locationId).order('created_at', { ascending: false })) as Request[],
  })
  const deals = useQuery({
    queryKey: keys.deals,
    queryFn: async () => unwrap(await supabase.from('deals').select('*').eq('location_id', locationId).order('created_at', { ascending: false })) as Deal[],
  })
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Заявки" actions={<Button size="sm" variant="primary" icon={<ClipboardList className="size-3.5" />} onClick={onNewRequest}>Новая заявка</Button>}>
        <QueryState query={requests} empty={!requests.data?.length} emptyTitle="Заявок нет">
          <ul className="divide-y divide-slate-100">
            {requests.data?.map((r) => (
              <li key={r.id} className="py-2 text-sm">
                <Link to={`/requests/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.number}</Link>
                <span className="ml-2 text-slate-500">{REQUEST_KIND_LABEL[r.kind]} · {fmtDate(r.created_at)}</span>
                <Badge className="ml-2" color={d.requestStatus(r.status_code)?.color}>{d.requestStatus(r.status_code)?.name}</Badge>
                <div className="text-slate-700">{r.item_name}{r.quantity > 1 ? ` × ${r.quantity}` : ''}</div>
              </li>
            ))}
          </ul>
        </QueryState>
      </Card>
      <Card title="Потенциальные сделки" actions={<Button size="sm" variant="primary" icon={<Briefcase className="size-3.5" />} onClick={onNewDeal}>Новая сделка</Button>}>
        <QueryState query={deals} empty={!deals.data?.length} emptyTitle="Сделок нет">
          <ul className="divide-y divide-slate-100">
            {deals.data?.map((x) => (
              <li key={x.id}>
                <button className="w-full py-2 text-left text-sm hover:bg-slate-50" onClick={() => setEdit(x)}>
                  <span className="font-medium text-brand-700">{x.title}</span>
                  <Badge className="ml-2" color={d.dealStage(x.stage_code)?.kind === 'won' ? 'green' : d.dealStage(x.stage_code)?.kind === 'lost' ? 'rose' : 'blue'}>{d.dealStage(x.stage_code)?.name}</Badge>
                  <div className="text-slate-600">{fmtMoney(x.amount)} · {d.profileName(x.manager_id)}{x.next_step ? ` · ${x.next_step}` : ''}</div>
                </button>
              </li>
            ))}
          </ul>
        </QueryState>
      </Card>
      {edit && <DealFormModal open onClose={() => setEdit(null)} locationId={locationId} deal={edit} />}
    </div>
  )
}
