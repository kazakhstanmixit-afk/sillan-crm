import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList } from 'lucide-react'
import { Badge, Button, Card, QueryState } from '@/components/ui'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate, fmtMoney } from '@/lib/format'
import { REQUEST_KIND_LABEL } from '@/lib/labels'
import type { Request } from '@/lib/types'
import { clientKeys } from '../api'

/** Заявки клиента в отделы */
export function SalesTab({ locationId, onNewRequest }: { locationId: string; onNewRequest: () => void }) {
  const d = useDicts()
  const requests = useQuery({
    queryKey: clientKeys(locationId).requests,
    queryFn: async () => unwrap(await supabase.from('requests').select('*').eq('location_id', locationId).order('created_at', { ascending: false })) as Request[],
  })
  return (
    <Card title="Заявки" actions={<Button size="sm" variant="primary" icon={<ClipboardList className="size-3.5" />} onClick={onNewRequest}>Новая заявка</Button>}>
      <QueryState query={requests} empty={!requests.data?.length} emptyTitle="Заявок нет">
        <ul className="divide-y divide-slate-100">
          {requests.data?.map((r) => (
            <li key={r.id} className="py-2 text-sm">
              <Link to={`/requests/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.number}</Link>
              <span className="ml-2 text-slate-500">{REQUEST_KIND_LABEL[r.kind]} · {fmtDate(r.created_at)}</span>
              <Badge className="ml-2" color={d.requestStatus(r.status_code)?.color}>{d.requestStatus(r.status_code)?.name}</Badge>
              <div className="text-slate-700">{r.item_name}{r.quantity > 1 ? ` × ${r.quantity}` : ''}{r.budget ? ` · ${fmtMoney(r.budget)}` : ''}</div>
            </li>
          ))}
        </ul>
      </QueryState>
    </Card>
  )
}
