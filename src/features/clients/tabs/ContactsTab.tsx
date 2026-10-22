import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, MessageCircle, Pencil, Phone, Plus, Star, Archive } from 'lucide-react'
import { Badge, Button, Card, Checkbox, ConfirmDialog, Field, Input, Modal, QueryState, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { formatPhone, telHref, waHref } from '@/lib/phone'
import { CHANNEL_LABEL, DECISION_ROLE_LABEL } from '@/lib/labels'
import type { Contact } from '@/lib/types'
import { clientKeys } from '../api'

const schema = z.object({
  full_name: z.string().trim().max(200),
  position: z.string().trim().max(100),
  phone: z.string().trim().max(50).refine((v) => !v || v.replace(/\D/g, '').length >= 6, 'Проверьте номер'),
  whatsapp: z.string().trim().max(50).refine((v) => !v || v.replace(/\D/g, '').length >= 6, 'Проверьте номер'),
  email: z.union([z.literal(''), z.string().trim().email('Неверный e-mail')]),
  decision_role: z.string(),
  preferred_channel: z.string(),
  comment: z.string().max(2000),
  is_actual: z.boolean(),
  is_primary: z.boolean(),
}).refine((v) => v.full_name || v.phone || v.whatsapp || v.email, { message: 'Укажите хотя бы ФИО, телефон, WhatsApp или e-mail', path: ['full_name'] })
type Form = z.infer<typeof schema>

const nul = (v: string) => (v.trim() === '' ? null : v.trim())

export function ContactsTab({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const key = clientKeys(locationId).contacts
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const [archiving, setArchiving] = useState<Contact | null>(null)
  const qc = useQueryClient()
  const toast = useToast()

  const q = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(await supabase.from('contacts').select('*').eq('location_id', locationId)
        .order('is_primary', { ascending: false }).order('is_actual', { ascending: false }).order('created_at')) as Contact[],
  })
  const list = (q.data ?? []).filter((c) => (showArchived ? true : !c.archived_at))

  const archive = useMutation({
    mutationFn: async (c: Contact) => unwrap(await supabase.from('contacts').update({ archived_at: new Date().toISOString(), is_primary: false }).eq('id', c.id).select('id')),
    onSuccess: () => {
      toast.success('Контакт перенесён в архив')
      qc.invalidateQueries({ queryKey: ['location', locationId] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      setArchiving(null)
    },
    onError: (e) => toast.error(e),
  })

  return (
    <Card
      title="Контакты"
      actions={
        <>
          <Checkbox label="Показать архивные" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {canEdit && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>Добавить контакт</Button>}
        </>
      }
    >
      <QueryState query={q} empty={!list.length} emptyTitle="Контактов пока нет" emptyText="Добавьте руководителя или лицо, принимающее решения. Не вносите непроверенные телефоны.">
        <ul className="divide-y divide-slate-100">
          {list.map((c) => (
            <li key={c.id} className={`flex flex-wrap items-start justify-between gap-3 py-3 ${c.archived_at || !c.is_actual ? 'opacity-60' : ''}`}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">{c.full_name || 'Без имени'}</span>
                  {c.position && <span className="text-sm text-slate-500">{c.position}</span>}
                  {c.is_primary && <Badge color="brand"><Star className="mr-0.5 size-3" />Основной</Badge>}
                  {c.decision_role && <Badge color={c.decision_role === 'decision_maker' ? 'green' : 'gray'}>{DECISION_ROLE_LABEL[c.decision_role]}</Badge>}
                  {!c.is_actual && <Badge color="amber">Неактуален</Badge>}
                  {c.archived_at && <Badge color="slate">Архив</Badge>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {c.phone && <a href={telHref(c.phone)} className="inline-flex items-center gap-1 text-brand-700 hover:underline"><Phone className="size-3.5" />{formatPhone(c.phone)}</a>}
                  {c.whatsapp && <a href={waHref(c.whatsapp)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-700 hover:underline"><MessageCircle className="size-3.5" />{formatPhone(c.whatsapp)}</a>}
                  {c.email && <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 text-brand-700 hover:underline"><Mail className="size-3.5" />{c.email}</a>}
                  {c.preferred_channel && <span className="text-slate-500">Предпочитает: {CHANNEL_LABEL[c.preferred_channel]}</span>}
                </div>
                {c.comment && <p className="whitespace-pre-line text-sm text-slate-600">{c.comment}</p>}
              </div>
              {canEdit && !c.archived_at && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(c)}>Изменить</Button>
                  <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} onClick={() => setArchiving(c)} aria-label="В архив" />
                </div>
              )}
            </li>
          ))}
        </ul>
      </QueryState>
      {editing && <ContactForm locationId={locationId} contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!archiving} title="Перенести контакт в архив?" onClose={() => setArchiving(null)} loading={archive.isPending} onConfirm={() => archiving && archive.mutate(archiving)} confirmText="В архив">
        Контакт «{archiving?.full_name || archiving?.phone}» скроется из карточки, но останется в истории.
      </ConfirmDialog>
    </Card>
  )
}

function ContactForm({ locationId, contact, onClose }: { locationId: string; contact: Contact | null; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: contact?.full_name ?? '', position: contact?.position ?? '', phone: contact?.phone ?? '', whatsapp: contact?.whatsapp ?? '',
      email: contact?.email ?? '', decision_role: contact?.decision_role ?? '', preferred_channel: contact?.preferred_channel ?? '',
      comment: contact?.comment ?? '', is_actual: contact?.is_actual ?? true, is_primary: contact?.is_primary ?? false,
    },
  })
  const mut = useMutation({
    mutationFn: async (v: Form) => {
      const row = {
        full_name: nul(v.full_name), position: nul(v.position), phone: nul(v.phone), whatsapp: nul(v.whatsapp), email: nul(v.email),
        decision_role: v.decision_role || null, preferred_channel: v.preferred_channel || null, comment: nul(v.comment),
        is_actual: v.is_actual, is_primary: v.is_primary,
      }
      const res = contact
        ? await supabase.from('contacts').update(row).eq('id', contact.id).select('id')
        : await supabase.from('contacts').insert({ ...row, location_id: locationId }).select('id')
      const data = unwrap(res)
      if (!data?.length) throw new Error('Недостаточно прав')
    },
    onSuccess: () => {
      toast.success(contact ? 'Контакт обновлён' : 'Контакт добавлен')
      qc.invalidateQueries({ queryKey: ['location', locationId] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })
  const submit = handleSubmit((v) => mut.mutate(v))
  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!mut.isPending}
      title={contact ? 'Изменить контакт' : 'Новый контакт'}
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} onClick={submit}>Сохранить</Button></>}
    >
      <form onSubmit={(e) => { e.preventDefault(); submit() }} noValidate className="grid gap-3 sm:grid-cols-2">
        <Field label="ФИО" error={errors.full_name?.message}>{(id) => <Input id={id} aria-invalid={!!errors.full_name} {...register('full_name')} />}</Field>
        <Field label="Должность">{(id) => <Input id={id} {...register('position')} />}</Field>
        <Field label="Телефон" error={errors.phone?.message}>{(id) => <Input id={id} type="tel" {...register('phone')} />}</Field>
        <Field label="WhatsApp" error={errors.whatsapp?.message}>{(id) => <Input id={id} type="tel" {...register('whatsapp')} />}</Field>
        <Field label="E-mail" error={errors.email?.message}>{(id) => <Input id={id} type="email" {...register('email')} />}</Field>
        <Field label="Роль в принятии решения">
          {(id) => <Select id={id} {...register('decision_role')}><option value="">Не указано</option>{Object.entries(DECISION_ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
        </Field>
        <Field label="Предпочтительный способ связи">
          {(id) => <Select id={id} {...register('preferred_channel')}><option value="">Не указано</option>{Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
        </Field>
        <div className="flex flex-col justify-end gap-2">
          <Checkbox label="Основной контакт" {...register('is_primary')} />
          <Checkbox label="Контакт актуален" {...register('is_actual')} />
        </div>
        <Field label="Комментарий" className="sm:col-span-2">{(id) => <Textarea id={id} {...register('comment')} />}</Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
