import { useQuery } from '@tanstack/react-query'
import { Card, QueryState } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { fmtDateTime } from '@/lib/format'
import { clientKeys } from '../api'

interface Log { id: number; actor_id: string | null; entity: string; entity_id: string | null; action: string; details: Record<string, unknown>; created_at: string }
interface Assignment { id: string; from_manager_id: string | null; to_manager_id: string | null; reason: string | null; assigned_by: string | null; created_at: string }

const ENTITY: Record<string, string> = {
  locations: 'Карточка', contacts: 'Контакт', location_equipment: 'Оборудование', location_photos: 'Фото', comments: 'Комментарий',
  visits: 'Визит', requests: 'Заявка', deals: 'Сделка', location_directions: 'Направление', location_services: 'Услуга', companies: 'Компания',
}
const ACTION: Record<string, string> = { insert: 'добавлено', update: 'изменено', delete: 'удалено', archive: 'в архив', restore: 'возвращено из архива' }
const FIELD: Record<string, string> = {
  name: 'название', status_code: 'статус', city: 'город', district: 'район', source_address: 'адрес из источника', confirmed_address: 'подтверждённый адрес',
  phones: 'телефоны', manager_id: 'ответственный', posts_count: 'посты', lifts_count: 'подъёмники', company_id: 'компания', full_name: 'ФИО', phone: 'телефон',
  is_actual: 'актуальность', condition: 'состояние', need: 'потребность', quantity: 'количество', body: 'текст', status: 'статус', result: 'результат',
  stage_code: 'стадия', amount: 'сумма', website: 'сайт', client_type: 'тип клиента', next_contact_date: 'следующий контакт', archived_at: 'архив',
  infrastructure_note: 'о сервисе', capacity_note: 'возможности', address_note: 'как найти', lat: 'широта', lng: 'долгота', is_primary: 'основной',
}

function describe(l: Log): string {
  if (l.entity === 'location_directions' || l.entity === 'location_services') return String((l.details as { name?: string }).name ?? '')
  if (l.action === 'update') {
    const keys = Object.keys(l.details)
    return keys.map((k) => FIELD[k] ?? k).join(', ')
  }
  const d = l.details as Record<string, unknown>
  return String(d.name ?? d.full_name ?? d.title ?? d.item_name ?? '')
}

export function HistoryTab({ locationId }: { locationId: string }) {
  const d = useDicts()
  const q = useQuery({
    queryKey: clientKeys(locationId).history,
    queryFn: async () => {
      const [logs, assigns] = await Promise.all([
        supabase.from('activity_logs').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(300),
        supabase.from('manager_assignments').select('*').eq('location_id', locationId).order('created_at', { ascending: false }),
      ])
      return { logs: unwrap(logs) as Log[], assigns: unwrap(assigns) as Assignment[] }
    },
  })
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card title="Журнал изменений" bodyClassName="p-0">
        <QueryState query={q} empty={!q.data?.logs.length} emptyTitle="Изменений пока нет">
          <ul className="divide-y divide-slate-100">
            {q.data?.logs.map((l) => (
              <li key={l.id} className="px-4 py-2 text-sm">
                <div className="flex flex-wrap gap-x-2 text-xs text-slate-500">
                  <span>{fmtDateTime(l.created_at)}</span>
                  <span>{l.actor_id ? d.profileName(l.actor_id) : 'Система / импорт'}</span>
                </div>
                <div>
                  <span className="font-medium">{ENTITY[l.entity] ?? l.entity}</span> — {ACTION[l.action] ?? l.action}
                  {describe(l) && <span className="text-slate-600">: {describe(l)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </Card>
      <Card title="История ответственных">
        <QueryState query={q} empty={!q.data?.assigns.length} emptyTitle="Ответственный не назначался">
          <ul className="space-y-2 text-sm">
            {q.data?.assigns.map((a) => (
              <li key={a.id} className="border-l-2 border-brand-200 pl-3">
                <div className="text-xs text-slate-500">{fmtDateTime(a.created_at)} · {a.assigned_by ? d.profileName(a.assigned_by) : 'Система'}</div>
                <div>{a.from_manager_id ? d.profileName(a.from_manager_id) : 'Без ответственного'} → <b>{a.to_manager_id ? d.profileName(a.to_manager_id) : 'Без ответственного'}</b></div>
                {a.reason && <div className="text-xs text-slate-600">Причина: {a.reason}</div>}
              </li>
            ))}
          </ul>
        </QueryState>
      </Card>
    </div>
  )
}
