import { useEffect, useRef, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, ClipboardList, ImagePlus } from 'lucide-react'
import { Button, Checkbox, ChipSelect, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { INTEREST_LABEL } from '@/lib/labels'
import type { Contact, Visit } from '@/lib/types'
import { uploadLocationPhotos } from '@/features/clients/tabs/PhotosTab'
import { RequestFormModal } from '@/features/requests/RequestFormModal'
import { DealFormModal } from '@/features/deals/DealFormModal'

const schema = z.object({
  status: z.enum(['done', 'failed']),
  actual_at: z.string().min(1, 'Укажите время визита'),
  talked_to: z.string().max(200),
  contact_id: z.string(),
  result: z.string().max(5000),
  services_note: z.string().max(2000),
  equipment_note: z.string().max(2000),
  needs: z.string().max(3000),
  interest: z.string(),
  agreements: z.string().max(3000),
  objections: z.string().max(3000),
  next_step: z.string().max(1000),
  follow_up_required: z.boolean(),
  next_contact_date: z.string(),
  schedule_next_date: z.string(),
  location_status: z.string(),
  comment: z.string().max(3000),
  service_ids: z.array(z.string()),
}).superRefine((v, ctx) => {
  if (v.status === 'done' && !v.result.trim()) ctx.addIssue({ code: 'custom', path: ['result'], message: 'Опишите результат визита' })
  if (v.status === 'failed' && !v.comment.trim()) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите, почему визит не состоялся' })
  if (v.follow_up_required && !v.next_contact_date && !v.schedule_next_date) ctx.addIssue({ code: 'custom', path: ['next_contact_date'], message: 'Укажите дату следующего контакта или визита' })
})
type Form = z.infer<typeof schema>

const localNow = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

/** Результат визита — форма удобна для заполнения со смартфона */
export function VisitResultDialog({ visit, locationName, onClose }: { visit: Visit; locationName: string; onClose: () => void }) {
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [saved, setSaved] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [dealOpen, setDealOpen] = useState(false)

  const extra = useQuery({
    queryKey: ['visit-result-extra', visit.location_id],
    queryFn: async () => {
      const [contacts, services] = await Promise.all([
        supabase.from('contacts').select('id,full_name,position,phone').eq('location_id', visit.location_id).is('archived_at', null).order('is_primary', { ascending: false }),
        supabase.from('location_services').select('service_id').eq('location_id', visit.location_id),
      ])
      return { contacts: unwrap(contacts) as Pick<Contact, 'id' | 'full_name' | 'position' | 'phone'>[], services: (unwrap(services) as { service_id: string }[]).map((s) => s.service_id) }
    },
  })

  const { register, handleSubmit, control, watch, reset, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      status: visit.status === 'failed' ? 'failed' : 'done',
      actual_at: visit.actual_at ? toLocalInput(visit.actual_at) : localNow(),
      talked_to: visit.talked_to ?? '', contact_id: visit.contact_id ?? '', result: visit.result ?? '',
      services_note: visit.services_note ?? '', equipment_note: visit.equipment_note ?? '', needs: visit.needs ?? '',
      interest: visit.interest ?? '', agreements: visit.agreements ?? '', objections: visit.objections ?? '', next_step: visit.next_step ?? '',
      follow_up_required: visit.follow_up_required, next_contact_date: visit.next_contact_date ?? '', schedule_next_date: '',
      location_status: '', comment: visit.comment ?? '', service_ids: [],
    },
  })
  useEffect(() => {
    if (extra.data) reset((v) => ({ ...v, service_ids: extra.data.services }), { keepDirtyValues: true })
  }, [extra.data, reset])
  const status = watch('status')

  const mut = useMutation({
    mutationFn: async (v: Form) => {
      const { service_ids, ...rest } = v
      unwrap(await supabase.rpc('complete_visit', { p_visit: visit.id, p_data: { ...rest, actual_at: new Date(v.actual_at).toISOString() } }))
      const before = [...(extra.data?.services ?? [])].sort().join()
      if (extra.data && [...service_ids].sort().join() !== before) {
        unwrap(await supabase.rpc('set_location_links', { p_location: visit.location_id, p_direction_ids: null, p_service_ids: service_ids }))
      }
      let photoErrors: string[] = []
      if (files.length) {
        const r = await uploadLocationPhotos(visit.location_id, files, visit.id)
        photoErrors = r.errors
      }
      return photoErrors
    },
    onSuccess: (photoErrors) => {
      toast.success('Результат визита сохранён')
      photoErrors.forEach((e) => toast.error(e))
      setFiles([])
      setSaved(true)
      qc.invalidateQueries({ queryKey: ['plan'] })
      qc.invalidateQueries({ queryKey: ['visits'] })
      qc.invalidateQueries({ queryKey: ['location', visit.location_id] })
      qc.invalidateQueries({ queryKey: ['clients'] })
    },
    onError: (e) => toast.error(e),
  })
  const submit = handleSubmit((v) => mut.mutate(v))

  return (
    <>
      <Modal
        open
        size="lg"
        onClose={onClose}
        dismissable={!mut.isPending}
        title={`Результат визита: ${locationName}`}
        footer={saved ? (
          <>
            <span className="mr-auto text-sm text-emerald-700">Сохранено. Создать по итогам визита:</span>
            <Button icon={<ClipboardList className="size-4" />} onClick={() => setRequestOpen(true)}>Заявку</Button>
            <Button icon={<Briefcase className="size-4" />} onClick={() => setDealOpen(true)}>Сделку</Button>
            <Button variant="primary" onClick={onClose}>Готово</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={mut.isPending}>Отмена</Button>
            <Button variant="primary" loading={mut.isPending} onClick={submit}>Сохранить результат</Button>
          </>
        )}
      >
        <form onSubmit={(e) => { e.preventDefault(); submit() }} noValidate className="grid gap-3 sm:grid-cols-2">
          <Field label="Итог визита">
            {(id) => (
              <Select id={id} {...register('status')} disabled={saved}>
                <option value="done">Визит состоялся</option>
                <option value="failed">Не состоялся</option>
              </Select>
            )}
          </Field>
          <Field label="Фактическое время" error={errors.actual_at?.message}>{(id) => <Input id={id} type="datetime-local" {...register('actual_at')} disabled={saved} />}</Field>

          {status === 'done' ? (
            <>
              <Field label="Фактический результат" required error={errors.result?.message} className="sm:col-span-2">{(id) => <Textarea id={id} aria-invalid={!!errors.result} {...register('result')} disabled={saved} />}</Field>
              <Field label="С кем общался">
                {(id) => (
                  <Select id={id} {...register('contact_id')} disabled={saved}>
                    <option value="">Выбрать из контактов…</option>
                    {extra.data?.contacts.map((c) => <option key={c.id} value={c.id}>{[c.full_name, c.position].filter(Boolean).join(', ') || c.phone}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="…или впишите" hint="Если контакта ещё нет в карточке">{(id) => <Input id={id} {...register('talked_to')} disabled={saved} />}</Field>
              <Field label="Какие услуги предоставляет точка" className="sm:col-span-2">
                {() => (
                  <Controller control={control} name="service_ids" render={({ field }) => (
                    <ChipSelect disabled={saved} options={d.activeServices.map((s) => ({ value: s.id, label: s.name }))} value={field.value} onChange={field.onChange} />
                  )} />
                )}
              </Field>
              <Field label="Используемое оборудование" hint="Подробно оборудование можно внести во вкладке «Оборудование»" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('equipment_note')} disabled={saved} />}</Field>
              <Field label="Выявленные потребности" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('needs')} disabled={saved} />}</Field>
              <Field label="Заинтересованность в покупке">
                {(id) => <Select id={id} {...register('interest')} disabled={saved}><option value="">Не оценена</option>{Object.entries(INTEREST_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
              </Field>
              <Field label="Изменить статус клиента">
                {(id) => <Select id={id} {...register('location_status')} disabled={saved}><option value="">Оставить как есть</option>{d.clientStatuses.filter((s) => s.is_active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>}
              </Field>
              <Field label="Договорённости">{(id) => <Textarea id={id} rows={2} {...register('agreements')} disabled={saved} />}</Field>
              <Field label="Возражения">{(id) => <Textarea id={id} rows={2} {...register('objections')} disabled={saved} />}</Field>
              <Field label="Следующий шаг" className="sm:col-span-2">{(id) => <Input id={id} {...register('next_step')} disabled={saved} />}</Field>
            </>
          ) : null}

          <div className="sm:col-span-2"><Checkbox label="Требуется повторный контакт" {...register('follow_up_required')} disabled={saved} /></div>
          <Field label="Дата следующего контакта" error={errors.next_contact_date?.message}>{(id) => <Input id={id} type="date" {...register('next_contact_date')} disabled={saved} />}</Field>
          <Field label="Запланировать следующий визит на" hint="Визит появится в плане на эту дату">{(id) => <Input id={id} type="date" {...register('schedule_next_date')} disabled={saved} />}</Field>
          <Field label={status === 'failed' ? 'Причина / комментарий' : 'Комментарий'} required={status === 'failed'} error={errors.comment?.message} className="sm:col-span-2">
            {(id) => <Textarea id={id} rows={2} {...register('comment')} disabled={saved} />}
          </Field>
          {!saved && (
            <div className="sm:col-span-2">
              <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { setFiles((f) => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = '' }} />
              <Button size="sm" icon={<ImagePlus className="size-4" />} onClick={() => fileInput.current?.click()}>Добавить фото</Button>
              {files.length > 0 && <span className="ml-2 text-sm text-slate-600">Выбрано фото: {files.length} <button type="button" className="text-rose-600 underline" onClick={() => setFiles([])}>убрать</button></span>}
            </div>
          )}
          <button type="submit" hidden />
        </form>
      </Modal>
      <RequestFormModal open={requestOpen} onClose={() => setRequestOpen(false)} locationId={visit.location_id} visitId={visit.id} />
      <DealFormModal open={dealOpen} onClose={() => setDealOpen(false)} locationId={visit.location_id} visitId={visit.id} />
    </>
  )
}
