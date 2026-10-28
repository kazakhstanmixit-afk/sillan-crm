import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, CheckCircle2, Pencil, UserCheck } from 'lucide-react'
import { Button, Card, ConfirmDialog, Field, InfoRow, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { usePerms } from '@/auth/AuthProvider'
import { fmtDate, fmtDateTime, mapHref } from '@/lib/format'
import { formatPhone, splitPhones, telHref } from '@/lib/phone'
import { SOURCE_LABEL } from '@/lib/labels'
import type { Company, Location } from '@/lib/types'
import { clientKeys } from '../api'
import { CompanyPicker, type CompanyChoice } from '../CompanyPicker'
import { BulkAssignDialog } from '../BulkDialogs'

type Section = 'general' | 'location' | 'infra' | 'company'

const emptyToNull = (v: string) => (v.trim() === '' ? null : v.trim())
const optInt = z.union([z.literal(''), z.coerce.number().int('Целое число').min(0, 'Не меньше 0').max(500)])
const optNum = (min: number, max: number) => z.union([z.literal(''), z.coerce.number().min(min).max(max)])

const generalSchema = z.object({
  name: z.string().trim().min(2, 'Укажите название').max(200),
  status_code: z.string().min(1),
  client_type: z.string().max(100),
  website: z.string().max(200),
  phones: z.string().max(300),
})
const locationSchema = z.object({
  city: z.string().max(100),
  district: z.string().max(100),
  confirmed_address: z.string().max(300),
  address_note: z.string().max(500),
  lat: optNum(-90, 90),
  lng: optNum(-180, 180),
})
const infraSchema = z.object({
  segment: z.string(),
  posts_count: optInt,
  lifts_count: optInt,
  infrastructure_note: z.string().max(2000),
  capacity_note: z.string().max(2000),
})
const companySchema = z.object({
  name: z.string().trim().min(2, 'Укажите название').max(200),
  legal_name: z.string().max(200),
  bin: z.union([z.literal(''), z.string().regex(/^\d{12}$/, 'БИН — 12 цифр')]),
  client_type: z.string().max(100),
})

function useSaveLocation(id: string) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: async (patch: Partial<Location>) => {
      const rows = unwrap(await supabase.from('locations').update(patch).eq('id', id).select('id'))
      if (!rows?.length) throw new Error('Недостаточно прав для изменения этого клиента')
    },
    onSuccess: () => {
      toast.success('Изменения сохранены')
      qc.invalidateQueries({ queryKey: ['location', id] })
      qc.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (e) => toast.error(e),
  })
}

export function OverviewTab({ location: l, company, canEdit }: { location: Location; company: Company | null; canEdit: boolean }) {
  const d = useDicts()
  const perms = usePerms()
  const [edit, setEdit] = useState<Section | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const save = useSaveLocation(l.id)
  const map = mapHref({ lat: l.lat, lng: l.lng, address: l.confirmed_address ?? l.source_address, city: l.city, externalId: l.external_id })

  const editBtn = (s: Section) =>
    canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit(s)}>Изменить</Button>

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Общая информация" actions={editBtn('general')}>
        <dl>
          <InfoRow label="Название">{l.name}</InfoRow>
          <InfoRow label="Статус">{d.clientStatus(l.status_code)?.name}</InfoRow>
          <InfoRow label="Телефоны точки">
            {l.phones.length ? l.phones.map((p) => <a key={p} href={telHref(p)} className="mr-3 whitespace-nowrap text-brand-700 hover:underline">{formatPhone(p)}</a>) : null}
          </InfoRow>
          <InfoRow label="Сайт">{l.website && <a href={/^https?:/.test(l.website) ? l.website : `https://${l.website}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{l.website}</a>}</InfoRow>
          <InfoRow label="Источник">{SOURCE_LABEL[l.source] ?? l.source}{l.source_category ? ` · ${l.source_category}` : ''}</InfoRow>
          {l.source_url && <InfoRow label="Запись в источнике"><a href={l.source_url} target="_blank" rel="noreferrer" className="break-all text-brand-700 hover:underline">{l.source_url}</a></InfoRow>}
          {l.external_id && <InfoRow label="Внешний ID">{l.external_id}</InfoRow>}
          <InfoRow label="Создано">{fmtDateTime(l.created_at)}</InfoRow>
          <InfoRow label="Изменено">{fmtDateTime(l.updated_at)}</InfoRow>
          {l.last_import_at && <InfoRow label="Последний импорт">{fmtDateTime(l.last_import_at)}</InfoRow>}
        </dl>
      </Card>

      <Card title="Компания (юрлицо)" actions={canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEdit('company')}>{company ? 'Изменить' : 'Указать'}</Button>}>
        {company ? (
          <dl>
            <InfoRow label="Название">{company.name}</InfoRow>
            <InfoRow label="Юридическое лицо">{company.legal_name}</InfoRow>
            <InfoRow label="БИН">{company.bin}</InfoRow>
          </dl>
        ) : <p className="text-sm text-slate-500">Юрлицо не указано.</p>}
      </Card>

      <Card title="Фактическое расположение" actions={<>{map && <a href={map} target="_blank" rel="noreferrer" className="text-sm text-brand-700 hover:underline">Карта</a>}{editBtn('location')}</>}>
        <dl>
          <InfoRow label="Город">{l.city}</InfoRow>
          <InfoRow label="Район">{l.district}</InfoRow>
          <InfoRow label="Подтверждённый адрес">
            {l.confirmed_address && <span className="inline-flex items-start gap-1">{l.confirmed_address}<CheckCircle2 className="mt-0.5 size-3.5 text-emerald-600" /></span>}
          </InfoRow>
          <InfoRow label="Адрес из источника">{l.source_address}</InfoRow>
          <InfoRow label="Как найти">{l.address_note}</InfoRow>
          <InfoRow label="Координаты">{l.lat != null && l.lng != null ? `${l.lat}, ${l.lng}` : null}</InfoRow>
        </dl>
        <p className="mt-2 text-xs text-slate-400">Импорт обновляет только «адрес из источника»; подтверждённый менеджером адрес не перезаписывается.</p>
      </Card>

      <Card title="Инфраструктура" actions={editBtn('infra')}>
        <dl>
          <InfoRow label="Сегментация">{l.segment}</InfoRow>
          <InfoRow label="Рабочих постов">{l.posts_count}</InfoRow>
          <InfoRow label="Подъёмников">{l.lifts_count}</InfoRow>
          <InfoRow label="О сервисе">{l.infrastructure_note && <span className="whitespace-pre-line">{l.infrastructure_note}</span>}</InfoRow>
          <InfoRow label="Размеры и возможности">{l.capacity_note && <span className="whitespace-pre-line">{l.capacity_note}</span>}</InfoRow>
        </dl>
      </Card>

      <Card title="Работа с клиентом">
        <dl>
          <InfoRow label="Ответственный">{l.manager_id ? d.profileName(l.manager_id) : 'Не назначен'}</InfoRow>
          <InfoRow label="Последний визит">{fmtDate(l.last_visit_at)}</InfoRow>
          <InfoRow label="Следующий визит">{fmtDate(l.next_visit_date)}</InfoRow>
          <InfoRow label="Следующий контакт">{fmtDate(l.next_contact_date)}</InfoRow>
        </dl>
        {(perms.assign || perms.archive) && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {perms.assign && <Button size="sm" icon={<UserCheck className="size-3.5" />} onClick={() => setAssignOpen(true)}>Сменить ответственного</Button>}
            {perms.archive && (l.archived_at
              ? <Button size="sm" icon={<ArchiveRestore className="size-3.5" />} loading={save.isPending} onClick={() => save.mutate({ archived_at: null })}>Вернуть из архива</Button>
              : <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} onClick={() => setArchiveOpen(true)}>В архив</Button>)}
          </div>
        )}
      </Card>

      {edit === 'general' && <GeneralEdit l={l} onClose={() => setEdit(null)} />}
      {edit === 'location' && <LocationEdit l={l} onClose={() => setEdit(null)} />}
      {edit === 'infra' && <InfraEdit l={l} onClose={() => setEdit(null)} />}
      {edit === 'company' && <CompanyEdit l={l} company={company} onClose={() => setEdit(null)} />}

      <BulkAssignDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        getRows={() => Promise.resolve([{ id: l.id, name: l.name, manager_id: l.manager_id, manager_name: l.manager_id ? d.profileName(l.manager_id) : null } as never])}
      />
      <ConfirmDialog
        open={archiveOpen}
        title="Перенести клиента в архив?"
        danger
        confirmText="В архив"
        loading={save.isPending}
        onClose={() => setArchiveOpen(false)}
        onConfirm={() => save.mutate({ archived_at: new Date().toISOString() }, { onSuccess: () => setArchiveOpen(false) })}
      >
        Клиент пропадёт из списков и планов. Вся история (визиты, заявки, комментарии) сохранится, клиента можно вернуть из архива.
      </ConfirmDialog>
    </div>
  )
}

function EditModal({ title, onClose, onSubmit, pending, children }: { title: string; onClose: () => void; onSubmit: () => void; pending: boolean; children: React.ReactNode }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      dismissable={!pending}
      footer={<><Button onClick={onClose} disabled={pending}>Отмена</Button><Button variant="primary" loading={pending} onClick={onSubmit}>Сохранить</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); onSubmit() }} noValidate className="grid gap-3 sm:grid-cols-2">
        {children}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

function GeneralEdit({ l, onClose }: { l: Location; onClose: () => void }) {
  const d = useDicts()
  const save = useSaveLocation(l.id)
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof generalSchema>>({
    resolver: zodResolver(generalSchema),
    defaultValues: { name: l.name, status_code: l.status_code, client_type: l.client_type ?? '', website: l.website ?? '', phones: l.phones.join(', ') },
  })
  const submit = handleSubmit((v) =>
    save.mutate({ name: v.name.trim(), status_code: v.status_code, website: emptyToNull(v.website), phones: splitPhones(v.phones) }, { onSuccess: onClose }),
  )
  return (
    <EditModal title="Общая информация" onClose={onClose} onSubmit={submit} pending={save.isPending}>
      <Field label="Название" required error={errors.name?.message} className="sm:col-span-2">{(id) => <Input id={id} aria-invalid={!!errors.name} {...register('name')} />}</Field>
      <Field label="Статус">{(id) => <Select id={id} {...register('status_code')}>{d.clientStatuses.filter((s) => s.is_active || s.code === l.status_code).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>}</Field>
      <Field label="Телефоны точки" hint="Через запятую" className="sm:col-span-2">{(id) => <Input id={id} {...register('phones')} />}</Field>
      <Field label="Сайт" className="sm:col-span-2">{(id) => <Input id={id} {...register('website')} />}</Field>
    </EditModal>
  )
}

function LocationEdit({ l, onClose }: { l: Location; onClose: () => void }) {
  const save = useSaveLocation(l.id)
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof locationSchema>>({
    resolver: zodResolver(locationSchema),
    defaultValues: {
      city: l.city ?? '', district: l.district ?? '', confirmed_address: l.confirmed_address ?? '', address_note: l.address_note ?? '',
      lat: l.lat ?? '', lng: l.lng ?? '',
    },
  })
  const submit = handleSubmit((v) =>
    save.mutate({
      city: emptyToNull(v.city), district: emptyToNull(v.district), confirmed_address: emptyToNull(v.confirmed_address),
      address_note: emptyToNull(v.address_note), lat: v.lat === '' ? null : Number(v.lat), lng: v.lng === '' ? null : Number(v.lng),
    }, { onSuccess: onClose }),
  )
  return (
    <EditModal title="Фактическое расположение" onClose={onClose} onSubmit={submit} pending={save.isPending}>
      <Field label="Город">{(id) => <Input id={id} {...register('city')} />}</Field>
      <Field label="Район">{(id) => <Input id={id} {...register('district')} />}</Field>
      <Field label="Подтверждённый фактический адрес" className="sm:col-span-2" hint={l.source_address ? `Из источника: ${l.source_address}` : undefined}>
        {(id) => <Input id={id} {...register('confirmed_address')} />}
      </Field>
      <Field label="Как найти" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('address_note')} />}</Field>
      <Field label="Широта" error={errors.lat?.message}>{(id) => <Input id={id} inputMode="decimal" {...register('lat')} />}</Field>
      <Field label="Долгота" error={errors.lng?.message}>{(id) => <Input id={id} inputMode="decimal" {...register('lng')} />}</Field>
    </EditModal>
  )
}

function InfraEdit({ l, onClose }: { l: Location; onClose: () => void }) {
  const save = useSaveLocation(l.id)
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof infraSchema>>({
    resolver: zodResolver(infraSchema),
    defaultValues: { segment: l.segment ?? '', posts_count: l.posts_count ?? '', lifts_count: l.lifts_count ?? '', infrastructure_note: l.infrastructure_note ?? '', capacity_note: l.capacity_note ?? '' },
  })
  const submit = handleSubmit((v) =>
    save.mutate({
      segment: (v.segment || null) as Location['segment'],
      posts_count: v.posts_count === '' ? null : v.posts_count, lifts_count: v.lifts_count === '' ? null : v.lifts_count,
      infrastructure_note: emptyToNull(v.infrastructure_note), capacity_note: emptyToNull(v.capacity_note),
    }, { onSuccess: onClose }),
  )
  return (
    <EditModal title="Инфраструктура" onClose={onClose} onSubmit={submit} pending={save.isPending}>
      <Field label="Сегментация">{(id) => <Select id={id} {...register('segment')}><option value="">—</option><option value="A">A</option><option value="B">B</option><option value="C">C</option></Select>}</Field>
      <Field label="Рабочих постов" error={errors.posts_count?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('posts_count')} />}</Field>
      <Field label="Подъёмников" error={errors.lifts_count?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('lifts_count')} />}</Field>
      <Field label="Дополнительно о сервисе" className="sm:col-span-2">{(id) => <Textarea id={id} {...register('infrastructure_note')} />}</Field>
      <Field label="Размеры и возможности точки" className="sm:col-span-2">{(id) => <Textarea id={id} {...register('capacity_note')} />}</Field>
    </EditModal>
  )
}

function CompanyEdit({ l, company, onClose }: { l: Location; company: Company | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [choice, setChoice] = useState<CompanyChoice>(company ? { kind: 'existing', id: company.id, name: company.name } : { kind: 'none' })
  const editing = company && choice.kind === 'existing' && choice.id === company.id
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof companySchema>>({
    resolver: zodResolver(companySchema),
    defaultValues: { name: company?.name ?? '', legal_name: company?.legal_name ?? '', bin: company?.bin ?? '', client_type: company?.client_type ?? '' },
  })
  const mut = useMutation({
    mutationFn: async (v: z.infer<typeof companySchema> | null) => {
      let companyId: string | null = null
      if (editing && v) {
        unwrap(await supabase.from('companies').update({ name: v.name.trim(), legal_name: emptyToNull(v.legal_name), bin: emptyToNull(v.bin) }).eq('id', company!.id).select('id'))
        companyId = company!.id
      } else if (choice.kind === 'existing') companyId = choice.id
      else if (choice.kind === 'new') {
        const c = unwrap(await supabase.from('companies').insert({ name: choice.name }).select('id').single()) as { id: string }
        companyId = c.id
      }
      if (companyId !== l.company_id) {
        const rows = unwrap(await supabase.from('locations').update({ company_id: companyId }).eq('id', l.id).select('id'))
        if (!rows?.length) throw new Error('Недостаточно прав для изменения этого клиента')
      }
    },
    onSuccess: () => {
      toast.success('Сохранено')
      qc.invalidateQueries({ queryKey: ['location', l.id] })
      qc.invalidateQueries({ queryKey: ['company'] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })
  const submit = editing ? handleSubmit((v) => mut.mutate(v)) : () => mut.mutate(null)
  return (
    <EditModal title="Компания (юрлицо)" onClose={onClose} onSubmit={submit} pending={mut.isPending}>
      <Field label="Компания" className="sm:col-span-2" hint="Выберите другую компанию или уберите привязку">{() => <CompanyPicker value={choice} onChange={setChoice} />}</Field>
      {editing && (
        <>
          <Field label="Название" required error={errors.name?.message}>{(id) => <Input id={id} {...register('name')} />}</Field>
          <Field label="Юридическое лицо">{(id) => <Input id={id} {...register('legal_name')} />}</Field>
          <Field label="БИН" error={errors.bin?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('bin')} />}</Field>
        </>
      )}
    </EditModal>
  )
}

export { clientKeys }
