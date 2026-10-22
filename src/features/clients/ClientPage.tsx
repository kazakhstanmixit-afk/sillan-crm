import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Briefcase, CalendarPlus, ClipboardList, MapPin, MessageCircle, Phone } from 'lucide-react'
import { Badge, Button, EmptyState, ErrorState, Spinner, Tabs } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { mapHref } from '@/lib/format'
import { telHref, waHref } from '@/lib/phone'
import { supabase } from '@/lib/supabase'
import { clientKeys, fetchLocation } from './api'
import { OverviewTab } from './tabs/OverviewTab'
import { ContactsTab } from './tabs/ContactsTab'
import { ServicesTab } from './tabs/ServicesTab'
import { EquipmentTab } from './tabs/EquipmentTab'
import { PhotosTab } from './tabs/PhotosTab'
import { CommentsTab } from './tabs/CommentsTab'
import { VisitsTab } from './tabs/VisitsTab'
import { SalesTab } from './tabs/SalesTab'
import { HistoryTab } from './tabs/HistoryTab'
import { AddToPlanDialog } from '@/features/visits/AddToPlanDialog'
import { RequestFormModal } from '@/features/requests/RequestFormModal'
import { DealFormModal } from '@/features/deals/DealFormModal'

const TABS = ['overview', 'contacts', 'services', 'equipment', 'photos', 'comments', 'visits', 'sales', 'history'] as const
type Tab = (typeof TABS)[number]

export default function ClientPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview'
  const d = useDicts()
  const perms = usePerms()
  const { session } = useAuth()
  const keys = clientKeys(id)
  const nav = useNavigate()

  const loc = useQuery({ queryKey: keys.location, queryFn: () => fetchLocation(id) })
  const company = useQuery({
    queryKey: ['company', loc.data?.company_id],
    enabled: Boolean(loc.data?.company_id),
    queryFn: async () => (await supabase.from('companies').select('*').eq('id', loc.data!.company_id!).maybeSingle()).data,
  })
  const primaryContact = useQuery({
    queryKey: [...keys.contacts, 'primary'],
    queryFn: async () =>
      (await supabase.from('contacts').select('phone, whatsapp').eq('location_id', id).is('archived_at', null).eq('is_actual', true)
        .order('is_primary', { ascending: false }).order('created_at').limit(1).maybeSingle()).data,
  })

  const [planOpen, setPlanOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [dealOpen, setDealOpen] = useState(false)

  if (loc.isLoading) return <Spinner />
  if (loc.error) return <ErrorState error={loc.error} onRetry={() => loc.refetch()} />
  if (!loc.data) {
    return (
      <EmptyState title="Клиент не найден">
        Запись удалена, перенесена в архив или закреплена за другим сотрудником. <Link className="text-brand-600 underline" to="/clients">К списку клиентов</Link>
      </EmptyState>
    )
  }
  const l = loc.data
  const canEdit = perms.edit_all || l.manager_id === session?.user.id
  const status = d.clientStatus(l.status_code)
  const phone = primaryContact.data?.phone ?? l.phones[0]
  const whatsapp = primaryContact.data?.whatsapp ?? phone
  const address = l.confirmed_address ?? l.source_address
  const map = mapHref({ lat: l.lat, lng: l.lng, address, city: l.city })

  return (
    <div className="space-y-4">
      <div>
        <button onClick={() => (window.history.length > 1 ? nav(-1) : nav('/clients'))} className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="size-4" /> Назад
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-slate-900">{l.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              {company.data && <Link to={`/clients?company=${company.data.id}`} className="hover:text-brand-700 hover:underline">{company.data.legal_name || company.data.name}</Link>}
              {address && <span>{[l.city, address].filter(Boolean).join(', ')}</span>}
              <Badge color={status?.color}>{status?.name ?? l.status_code}</Badge>
              {l.archived_at && <Badge color="slate">В архиве</Badge>}
              <span>Ответственный: {l.manager_id ? d.profileName(l.manager_id) : <span className="text-amber-700">не назначен</span>}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {phone && <a href={telHref(phone)}><Button size="sm" icon={<Phone className="size-3.5" />}>Позвонить</Button></a>}
            {whatsapp && <a href={waHref(whatsapp)} target="_blank" rel="noreferrer"><Button size="sm" icon={<MessageCircle className="size-3.5" />}>WhatsApp</Button></a>}
            {map && <a href={map} target="_blank" rel="noreferrer"><Button size="sm" icon={<MapPin className="size-3.5" />}>Открыть адрес</Button></a>}
            {!l.archived_at && (
              <>
                <Button size="sm" icon={<CalendarPlus className="size-3.5" />} onClick={() => setPlanOpen(true)}>В план</Button>
                <Button size="sm" icon={<ClipboardList className="size-3.5" />} onClick={() => setRequestOpen(true)}>Заявка</Button>
                <Button size="sm" icon={<Briefcase className="size-3.5" />} onClick={() => setDealOpen(true)}>Сделка</Button>
              </>
            )}
          </div>
        </div>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={(t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
        tabs={[
          { value: 'overview', label: 'Общее' },
          { value: 'contacts', label: 'Контакты' },
          { value: 'services', label: 'Направления и услуги' },
          { value: 'equipment', label: 'Оборудование' },
          { value: 'photos', label: 'Фото' },
          { value: 'comments', label: 'Комментарии' },
          { value: 'visits', label: 'Визиты' },
          { value: 'sales', label: 'Заявки и сделки' },
          { value: 'history', label: 'История' },
        ]}
      />

      {tab === 'overview' && <OverviewTab location={l} company={company.data ?? null} canEdit={canEdit} />}
      {tab === 'contacts' && <ContactsTab locationId={id} canEdit={canEdit} />}
      {tab === 'services' && <ServicesTab locationId={id} canEdit={canEdit} />}
      {tab === 'equipment' && <EquipmentTab locationId={id} canEdit={canEdit} />}
      {tab === 'photos' && <PhotosTab locationId={id} canEdit={canEdit} />}
      {tab === 'comments' && <CommentsTab locationId={id} canEdit={canEdit} />}
      {tab === 'visits' && <VisitsTab locationId={id} onPlan={() => setPlanOpen(true)} />}
      {tab === 'sales' && <SalesTab locationId={id} onNewRequest={() => setRequestOpen(true)} onNewDeal={() => setDealOpen(true)} />}
      {tab === 'history' && <HistoryTab locationId={id} />}

      <AddToPlanDialog open={planOpen} onClose={() => setPlanOpen(false)} locationIds={[id]} />
      <RequestFormModal open={requestOpen} onClose={() => setRequestOpen(false)} locationId={id} />
      <DealFormModal open={dealOpen} onClose={() => setDealOpen(false)} locationId={id} />
    </div>
  )
}
