import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui'
import { fmtDate, isOverdue } from '@/lib/format'
import { formatPhone } from '@/lib/phone'
import type { LocationListRow } from '@/lib/types'
import type { useDicts } from '@/lib/dictionaries'

type D = ReturnType<typeof useDicts>

export interface ClientColumn {
  key: string
  label: string
  sortKey?: string
  render: (r: LocationListRow, d: D) => ReactNode
  exportValue: (r: LocationListRow, d: D) => string
}

export const CLIENT_COLUMNS: ClientColumn[] = [
  {
    key: 'name', label: 'Название', sortKey: 'name',
    render: (r) => <Link to={`/clients/${r.id}`} className="font-medium text-brand-700 hover:underline">{r.name}</Link>,
    exportValue: (r) => r.name,
  },
  { key: 'company', label: 'Юрлицо / компания', sortKey: 'company_name', render: (r) => r.legal_name || r.company_name, exportValue: (r) => r.legal_name || r.company_name || '' },
  { key: 'city', label: 'Город', sortKey: 'city', render: (r) => r.city, exportValue: (r) => r.city ?? '' },
  { key: 'district', label: 'Район', sortKey: 'district', render: (r) => r.district, exportValue: (r) => r.district ?? '' },
  {
    key: 'address', label: 'Фактический адрес', sortKey: 'address',
    render: (r) => (
      <span className="inline-flex items-start gap-1">
        {r.address}
        {r.address_confirmed && <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" aria-label="Адрес подтверждён менеджером" />}
      </span>
    ),
    exportValue: (r) => r.address ?? '',
  },
  {
    key: 'directions', label: 'Направления',
    render: (r, d) => (
      <div className="flex max-w-xs flex-wrap gap-1">
        {r.direction_ids.map((id) => <Badge key={id} color="brand">{d.directionName(id)}</Badge>)}
      </div>
    ),
    exportValue: (r, d) => r.direction_ids.map((id) => d.directionName(id)).join(', '),
  },
  { key: 'contact', label: 'Контактное лицо', render: (r) => r.contact_name, exportValue: (r) => r.contact_name ?? '' },
  {
    key: 'phone', label: 'Телефон',
    render: (r) => (r.contact_phone ? <span className="whitespace-nowrap">{formatPhone(r.contact_phone)}</span> : null),
    exportValue: (r) => [r.contact_phone, ...r.phones.filter((p) => p !== r.contact_phone)].filter(Boolean).map((p) => formatPhone(p)).join(', '),
  },
  {
    key: 'manager', label: 'Ответственный', sortKey: 'manager_name',
    render: (r) => r.manager_name ?? <span className="text-amber-700">Не назначен</span>,
    exportValue: (r) => r.manager_name ?? '',
  },
  {
    key: 'status', label: 'Статус', sortKey: 'status_code',
    render: (r, d) => {
      const s = d.clientStatus(r.status_code)
      return <Badge color={s?.color}>{s?.name ?? r.status_code}</Badge>
    },
    exportValue: (r, d) => d.clientStatus(r.status_code)?.name ?? r.status_code,
  },
  { key: 'last_visit', label: 'Последний визит', sortKey: 'last_visit_at', render: (r) => <span className="whitespace-nowrap">{fmtDate(r.last_visit_at)}</span>, exportValue: (r) => fmtDate(r.last_visit_at) },
  {
    key: 'next_visit', label: 'Следующий визит', sortKey: 'next_visit_date',
    render: (r) => <span className={`whitespace-nowrap ${isOverdue(r.next_visit_date) ? 'font-medium text-rose-600' : ''}`}>{fmtDate(r.next_visit_date)}</span>,
    exportValue: (r) => fmtDate(r.next_visit_date),
  },
  { key: 'updated', label: 'Изменено', sortKey: 'updated_at', render: (r) => <span className="whitespace-nowrap">{fmtDate(r.updated_at)}</span>, exportValue: (r) => fmtDate(r.updated_at) },
]

export const DEFAULT_VISIBLE = ['name', 'company', 'city', 'district', 'address', 'directions', 'contact', 'phone', 'manager', 'status', 'last_visit', 'next_visit', 'updated']

const STORAGE_KEY = 'sillan.clients.columns.v1'

export interface ColumnPrefs { order: string[]; hidden: string[] }

export function loadColumnPrefs(): ColumnPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as ColumnPrefs
      const known = CLIENT_COLUMNS.map((c) => c.key)
      const order = [...p.order.filter((k) => known.includes(k)), ...known.filter((k) => !p.order.includes(k))]
      return { order, hidden: p.hidden.filter((k) => known.includes(k)) }
    }
  } catch {
    // настройки столбцов — необязательное удобство; при ошибке используем значения по умолчанию
  }
  return { order: CLIENT_COLUMNS.map((c) => c.key), hidden: CLIENT_COLUMNS.map((c) => c.key).filter((k) => !DEFAULT_VISIBLE.includes(k)) }
}

export function saveColumnPrefs(p: ColumnPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // хранилище браузера недоступно (приватный режим) — настройки действуют до перезагрузки
  }
}
