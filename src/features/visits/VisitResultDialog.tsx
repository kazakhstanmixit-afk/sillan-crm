import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useForm, Controller, type UseFormRegister } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImagePlus } from 'lucide-react'
import { Button, Checkbox, ChipSelect, Field, Input, Modal, Select, Spinner, Textarea, useToast, ErrorState } from '@/components/ui'
import { BrandIdSelect, BrandNameSelect } from '@/components/BrandSelect'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { INTEREST_LABEL, REQUEST_DEPT_LABEL, URGENCY_LABEL } from '@/lib/labels'
import type { Contact, Visit } from '@/lib/types'
import { uploadLocationPhotos } from '@/features/clients/tabs/PhotosTab'

const optInt = z.union([z.literal(''), z.coerce.number().int('Целое число').min(0, 'Не меньше 0').max(500)])
const eqItem = z.object({ on: z.boolean(), brand_id: z.string(), quantity: z.union([z.literal(''), z.coerce.number().int().min(1).max(999)]) })

const schema = z.object({
  status: z.enum(['done', 'failed']),
  actual_at: z.string().min(1, 'Укажите время визита'),
  result: z.string().max(5000),
  interest: z.string(),
  needs: z.string().max(3000),
  agreements: z.string().max(3000),
  next_step: z.string().max(1000),
  next_contact_date: z.string(),
  schedule_next_date: z.string(),
  location_status: z.string(),
  comment: z.string().max(3000),
  expansion_plans: z.string().max(3000),
  // карточка точки
  name: z.string().trim().max(200),
  legal_name: z.string().trim().max(200),
  bin: z.union([z.literal(''), z.string().regex(/^\d{12}$/, 'БИН — 12 цифр')]),
  address: z.string().trim().max(300),
  posts_count: optInt,
  lpr_full_name: z.string().trim().max(200),
  lpr_position: z.string().trim().max(100),
  lpr_phone: z.string().trim().max(50),
  lpr_whatsapp: z.string().trim().max(50),
  service_ids: z.array(z.string()),
  equipment: z.record(z.string(), eqItem),
  // заявки
  svc_on: z.boolean(), svc_item: z.string().max(300), svc_category: z.string(), svc_brand: z.string().max(100), svc_desc: z.string().max(3000), svc_urgency: z.string(),
  parts_on: z.boolean(), parts_item: z.string().max(300), parts_article: z.string().max(100), parts_brand: z.string().max(100), parts_qty: z.coerce.number().int().min(1).max(100000),
  sale_on: z.boolean(), sale_item: z.string().max(300), sale_category: z.string(), sale_brand: z.string().max(100), sale_qty: z.coerce.number().int().min(1).max(100000),
  sale_budget: z.union([z.literal(''), z.coerce.number().min(0).max(1e12)]), sale_comment: z.string().max(3000),
}).superRefine((v, ctx) => {
  if (v.status === 'done' && !v.result.trim()) ctx.addIssue({ code: 'custom', path: ['result'], message: 'Коротко опишите итог визита' })
  if (v.status === 'failed' && !v.comment.trim()) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Укажите, почему визит не состоялся' })
  if (v.status === 'done' && v.svc_on && !v.svc_item.trim()) ctx.addIssue({ code: 'custom', path: ['svc_item'], message: 'Укажите оборудование' })
  if (v.status === 'done' && v.parts_on && !v.parts_item.trim()) ctx.addIssue({ code: 'custom', path: ['parts_item'], message: 'Укажите запчасть' })
  if (v.status === 'done' && v.sale_on && !v.sale_item.trim()) ctx.addIssue({ code: 'custom', path: ['sale_item'], message: 'Укажите, что хотят купить' })
})
type Form = z.infer<typeof schema>

const localInput = (iso?: string | null) => {
  const d = iso ? new Date(iso) : new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-slate-100 pt-4 first:border-t-0 first:pt-0 sm:col-span-2">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  )
}

/**
 * Отчёт о визите — одна форма: итог визита, данные точки (название, юрлицо, адрес, ЛПР, посты, услуги,
 * оборудование с брендами), фото, планы развития и заявки в отделы. Всё сохраняется одной операцией
 * и сразу попадает в карточку клиента.
 */
export function VisitResultDialog({ visit, locationName, onClose }: { visit: Visit; locationName: string; onClose: () => void }) {
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const keys = useRef({ service: crypto.randomUUID(), parts: crypto.randomUUID(), equipment: crypto.randomUUID() })

  const card = useQuery({
    queryKey: ['visit-report', visit.location_id],
    queryFn: async () => {
      const [loc, contacts, services, equipment] = await Promise.all([
        supabase.from('locations').select('name, confirmed_address, source_address, posts_count, company:companies(legal_name, bin)').eq('id', visit.location_id).maybeSingle(),
        supabase.from('contacts').select('id, full_name, position, phone, whatsapp, decision_role, is_primary').eq('location_id', visit.location_id).is('archived_at', null).order('is_primary', { ascending: false }),
        supabase.from('location_services').select('service_id').eq('location_id', visit.location_id),
        supabase.from('location_equipment').select('category_id, brand_id, quantity').eq('location_id', visit.location_id).is('archived_at', null),
      ])
      return {
        loc: unwrap(loc) as unknown as { name: string; confirmed_address: string | null; source_address: string | null; posts_count: number | null; company: { legal_name: string | null; bin: string | null } | null } | null,
        contacts: unwrap(contacts) as Pick<Contact, 'id' | 'full_name' | 'position' | 'phone' | 'whatsapp' | 'decision_role' | 'is_primary'>[],
        services: (unwrap(services) as { service_id: string }[]).map((s) => s.service_id),
        equipment: unwrap(equipment) as { category_id: string | null; brand_id: string | null; quantity: number }[],
      }
    },
  })

  const { register, handleSubmit, control, watch, reset, setValue, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      status: visit.status === 'failed' ? 'failed' : 'done', actual_at: localInput(visit.actual_at), result: visit.result ?? '',
      interest: visit.interest ?? '', needs: visit.needs ?? '', agreements: visit.agreements ?? '', next_step: visit.next_step ?? '',
      next_contact_date: visit.next_contact_date ?? '', schedule_next_date: '', location_status: '', comment: visit.comment ?? '',
      expansion_plans: visit.expansion_plans ?? '',
      name: '', legal_name: '', bin: '', address: '', posts_count: '', lpr_full_name: '', lpr_position: '', lpr_phone: '', lpr_whatsapp: '',
      service_ids: [], equipment: {},
      svc_on: false, svc_item: '', svc_category: '', svc_brand: '', svc_desc: '', svc_urgency: 'normal',
      parts_on: false, parts_item: '', parts_article: '', parts_brand: '', parts_qty: 1,
      sale_on: false, sale_item: '', sale_category: '', sale_brand: '', sale_qty: 1, sale_budget: '', sale_comment: '',
    },
  })

  // подставить текущие данные карточки
  useEffect(() => {
    const c = card.data
    if (!c) return
    const lpr = c.contacts.find((x) => x.decision_role === 'decision_maker') ?? null
    const eq: Form['equipment'] = {}
    for (const e of c.equipment) if (e.category_id) eq[e.category_id] = { on: true, brand_id: e.brand_id ?? '', quantity: e.quantity }
    reset((v) => ({
      ...v,
      name: c.loc?.name ?? '', legal_name: c.loc?.company?.legal_name ?? '', bin: c.loc?.company?.bin ?? '',
      address: c.loc?.confirmed_address ?? c.loc?.source_address ?? '', posts_count: c.loc?.posts_count ?? '',
      lpr_full_name: lpr?.full_name ?? '', lpr_position: lpr?.position ?? '', lpr_phone: lpr?.phone ?? '', lpr_whatsapp: lpr?.whatsapp ?? '',
      service_ids: c.services, equipment: eq,
    }), { keepDirtyValues: true })
  }, [card.data, reset])

  const status = watch('status')
  const eqState = watch('equipment')
  const [svcOn, partsOn, saleOn] = [watch('svc_on'), watch('parts_on'), watch('sale_on')]

  const mut = useMutation({
    mutationFn: async (v: Form) => {
      const done = v.status === 'done'
      const requests = done ? [
        ...(v.svc_on ? [{ kind: 'service', item_name: v.svc_item, category_id: v.svc_category || null, brand: v.svc_brand, description: v.svc_desc, urgency: v.svc_urgency, client_request_id: keys.current.service }] : []),
        ...(v.parts_on ? [{ kind: 'parts', item_name: v.parts_item, article: v.parts_article, brand: v.parts_brand, quantity: v.parts_qty, client_request_id: keys.current.parts }] : []),
        ...(v.sale_on ? [{ kind: 'equipment', item_name: v.sale_item, category_id: v.sale_category || null, brand: v.sale_brand, quantity: v.sale_qty, budget: v.sale_budget === '' ? null : v.sale_budget, comment: v.sale_comment, client_request_id: keys.current.equipment }] : []),
      ] : []
      const payload = {
        status: v.status, actual_at: new Date(v.actual_at).toISOString(), result: v.result, interest: v.interest, needs: v.needs,
        agreements: v.agreements, next_step: v.next_step, follow_up_required: Boolean(v.next_contact_date || v.schedule_next_date),
        next_contact_date: v.next_contact_date, schedule_next_date: v.schedule_next_date, location_status: v.location_status,
        comment: v.comment, expansion_plans: done ? v.expansion_plans : '', talked_to: v.lpr_full_name,
        card: done ? {
          name: v.name, legal_name: v.legal_name, bin: v.bin, address: v.address, posts_count: v.posts_count,
          lpr: { full_name: v.lpr_full_name, position: v.lpr_position, phone: v.lpr_phone, whatsapp: v.lpr_whatsapp },
          service_ids: v.service_ids,
          equipment: Object.entries(v.equipment).filter(([, e]) => e.on).map(([category_id, e]) => ({ category_id, brand_id: e.brand_id || null, quantity: e.quantity === '' ? 1 : e.quantity })),
        } : {},
        requests,
      }
      const res = unwrap(await supabase.rpc('save_visit_report', { p_visit: visit.id, p_data: payload })) as { requests: { number: string }[] }
      let photoErrors: string[] = []
      if (files.length) photoErrors = (await uploadLocationPhotos(visit.location_id, files, visit.id)).errors
      return { numbers: res.requests.map((r) => r.number), photoErrors }
    },
    onSuccess: ({ numbers, photoErrors }) => {
      toast.success(numbers.length ? `Отчёт сохранён. Заявки: ${numbers.join(', ')}` : 'Отчёт о визите сохранён')
      photoErrors.forEach((e) => toast.error(e))
      for (const k of [['plan'], ['visits'], ['location', visit.location_id], ['clients'], ['requests'], ['visit-report', visit.location_id]]) qc.invalidateQueries({ queryKey: k })
      onClose()
    },
    onError: (e) => toast.error(e),
  })
  const submit = handleSubmit((v) => mut.mutate(v))

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      dismissable={!mut.isPending}
      title={`Результат визита: ${locationName || card.data?.loc?.name || ''}`}
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} onClick={submit}>Сохранить</Button></>}
    >
      {card.isLoading ? <Spinner /> : card.error ? <ErrorState error={card.error} onRetry={() => card.refetch()} /> : (
        <form onSubmit={(e) => { e.preventDefault(); submit() }} noValidate className="grid gap-4 sm:grid-cols-2">
          <Section title="Визит">
            <Field label="Итог">{(id) => <Select id={id} {...register('status')}><option value="done">Визит состоялся</option><option value="failed">Не состоялся</option></Select>}</Field>
            <Field label="Время визита" error={errors.actual_at?.message}>{(id) => <Input id={id} type="datetime-local" {...register('actual_at')} />}</Field>
            {status === 'done'
              ? <Field label="Как прошло" required error={errors.result?.message} className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} aria-invalid={!!errors.result} placeholder="С кем говорили, что показали, реакция" {...register('result')} />}</Field>
              : <Field label="Почему не состоялся" required error={errors.comment?.message} className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('comment')} />}</Field>}
          </Section>

          {status === 'done' && (
            <>
              <Section title="Точка" hint="Уже известное подставлено — исправьте, если не так. Попадёт в карточку клиента.">
                <Field label="Название СТО">{(id) => <Input id={id} {...register('name')} />}</Field>
                <Field label="Юридическое лицо">{(id) => <Input id={id} placeholder="ТОО «…» / ИП …" {...register('legal_name')} />}</Field>
                <Field label="Фактический адрес" hint="Если не совпадает с 2GIS" className="sm:col-span-2">{(id) => <Input id={id} {...register('address')} />}</Field>
                <Field label="БИН / ИИН" error={errors.bin?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('bin')} />}</Field>
                <Field label="Сколько постов" error={errors.posts_count?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('posts_count')} />}</Field>
              </Section>

              <Section title="ЛПР — кто принимает решения">
                <Field label="ФИО">{(id) => <Input id={id} {...register('lpr_full_name')} />}</Field>
                <Field label="Должность">{(id) => <Input id={id} placeholder="Владелец, директор…" {...register('lpr_position')} />}</Field>
                <Field label="Телефон">{(id) => <Input id={id} type="tel" {...register('lpr_phone')} />}</Field>
                <Field label="WhatsApp">{(id) => <Input id={id} type="tel" {...register('lpr_whatsapp')} />}</Field>
              </Section>

              <Section title="Услуги — чем занимается СТО">
                <div className="sm:col-span-2">
                  <Controller control={control} name="service_ids" render={({ field }) => (
                    <ChipSelect options={d.activeServices.map((s) => ({ value: s.id, label: s.name }))} value={field.value} onChange={field.onChange} />
                  )} />
                </div>
              </Section>

              <Section title="Оборудование на точке" hint="Отметьте, что стоит, и выберите бренд">
                <ul className="space-y-1.5 sm:col-span-2">
                  {d.activeCategories.map((c) => {
                    const e = eqState?.[c.id]
                    return (
                      <li key={c.id} className="flex flex-wrap items-center gap-2">
                        <Checkbox className="min-w-56 flex-1" label={c.name} checked={!!e?.on}
                          onChange={(ev) => setValue(`equipment.${c.id}`, { on: ev.target.checked, brand_id: e?.brand_id ?? '', quantity: e?.quantity ?? 1 }, { shouldDirty: true })} />
                        {e?.on && (
                          <>
                            <BrandIdSelect className="w-44" ariaLabel={`Бренд: ${c.name}`} value={e.brand_id} onChange={(b) => setValue(`equipment.${c.id}.brand_id`, b, { shouldDirty: true })} />
                            <Input className="w-20" type="number" min={1} aria-label={`Количество: ${c.name}`} value={String(e.quantity)} onChange={(ev) => setValue(`equipment.${c.id}.quantity`, ev.target.value === '' ? '' : Number(ev.target.value), { shouldDirty: true })} />
                            <span className="text-xs text-slate-500">шт.</span>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </Section>

              <Section title="Фото">
                <div className="sm:col-span-2">
                  <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { setFiles((f) => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = '' }} />
                  <Button size="sm" icon={<ImagePlus className="size-4" />} onClick={() => fileInput.current?.click()}>Добавить фото</Button>
                  {files.length > 0 && <span className="ml-2 text-sm text-slate-600">Выбрано: {files.length} <button type="button" className="text-rose-600 underline" onClick={() => setFiles([])}>убрать</button></span>}
                </div>
              </Section>

              <Section title="Будущее сервиса" hint="Планы расширения, новые посты, возможные заказы">
                <Field label="Планы и перспективы" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} placeholder="Например: весной открывают второй бокс, присматривают стенд развал-схождения" {...register('expansion_plans')} />}</Field>
                <Field label="Интерес к покупке">{(id) => <Select id={id} {...register('interest')}><option value="">Не оценён</option>{Object.entries(INTEREST_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
                <Field label="Статус клиента">{(id) => <Select id={id} {...register('location_status')}><option value="">Оставить как есть</option>{d.clientStatuses.filter((s) => s.is_active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>}</Field>
              </Section>

              <Section title="Заявки в отделы" hint="Отметьте, если клиенту что-то нужно — заявка уйдёт в отдел при сохранении">
                <div className="space-y-3 sm:col-span-2">
                  <RequestBlock on={svcOn} label={`${REQUEST_DEPT_LABEL.service} — ремонт или обслуживание оборудования`} register={register} name="svc_on">
                    <Field label="Какое оборудование" required error={errors.svc_item?.message}>{(id) => <Input id={id} placeholder="Например: подъёмник" {...register('svc_item')} />}</Field>
                    <Field label="Бренд">{(id) => <Controller control={control} name="svc_brand" render={({ field }) => <BrandNameSelect id={id} value={field.value} onChange={field.onChange} />} />}</Field>
                    <Field label="Категория">{(id) => <Select id={id} {...register('svc_category')}><option value="">Не указана</option>{d.activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
                    <Field label="Срочность">{(id) => <Select id={id} {...register('svc_urgency')}>{Object.entries(URGENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
                    <Field label="Что случилось" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('svc_desc')} />}</Field>
                  </RequestBlock>
                  <RequestBlock on={partsOn} label={REQUEST_DEPT_LABEL.parts} register={register} name="parts_on">
                    <Field label="Что нужно" required error={errors.parts_item?.message}>{(id) => <Input id={id} placeholder="Например: колодки тормозные" {...register('parts_item')} />}</Field>
                    <Field label="Артикул">{(id) => <Input id={id} {...register('parts_article')} />}</Field>
                    <Field label="Бренд / производитель">{(id) => <Controller control={control} name="parts_brand" render={({ field }) => <BrandNameSelect id={id} value={field.value} onChange={field.onChange} />} />}</Field>
                    <Field label="Количество">{(id) => <Input id={id} type="number" min={1} {...register('parts_qty')} />}</Field>
                  </RequestBlock>
                  <RequestBlock on={saleOn} label={`${REQUEST_DEPT_LABEL.equipment} — хотят купить`} register={register} name="sale_on">
                    <Field label="Что хотят купить" required error={errors.sale_item?.message}>{(id) => <Input id={id} placeholder="Например: балансировочный станок" {...register('sale_item')} />}</Field>
                    <Field label="Бренд">{(id) => <Controller control={control} name="sale_brand" render={({ field }) => <BrandNameSelect id={id} value={field.value} onChange={field.onChange} />} />}</Field>
                    <Field label="Категория">{(id) => <Select id={id} {...register('sale_category')}><option value="">Не указана</option>{d.activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
                    <Field label="Количество">{(id) => <Input id={id} type="number" min={1} {...register('sale_qty')} />}</Field>
                    <Field label="Бюджет, ₸">{(id) => <Input id={id} inputMode="numeric" {...register('sale_budget')} />}</Field>
                    <Field label="Когда планируют, детали">{(id) => <Input id={id} {...register('sale_comment')} />}</Field>
                  </RequestBlock>
                </div>
              </Section>

              <Section title="Дальше">
                <Field label="Следующий шаг" className="sm:col-span-2">{(id) => <Input id={id} {...register('next_step')} />}</Field>
                <Field label="Следующий контакт">{(id) => <Input id={id} type="date" {...register('next_contact_date')} />}</Field>
                <Field label="Запланировать визит на" hint="Появится в плане на эту дату">{(id) => <Input id={id} type="date" {...register('schedule_next_date')} />}</Field>
                <Field label="Комментарий" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('comment')} />}</Field>
              </Section>
            </>
          )}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  )
}

function RequestBlock({ on, label, register, name, children }: { on: boolean; label: string; register: UseFormRegister<Form>; name: 'svc_on' | 'parts_on' | 'sale_on'; children: ReactNode }) {
  return (
    <div className={`rounded-md border p-3 ${on ? 'border-brand-300 bg-brand-50/40' : 'border-slate-200'}`}>
      <Checkbox label={<span className="font-medium">{label}</span>} {...register(name)} />
      {on && <div className="mt-3 grid gap-3 sm:grid-cols-2">{children}</div>}
    </div>
  )
}
