import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { URGENCY_LABEL } from '@/lib/labels'

const schema = z.object({
  kind: z.enum(['equipment', 'parts']),
  item_name: z.string().trim().min(2, 'Укажите, что требуется').max(300),
  category_id: z.string(),
  brand: z.string().trim().max(100),
  model: z.string().trim().max(100),
  article: z.string().trim().max(100),
  quantity: z.coerce.number().int('Целое число').min(1, 'Минимум 1').max(100000),
  budget: z.union([z.literal(''), z.coerce.number().min(0, 'Не меньше 0').max(1e12)]),
  urgency: z.string(),
  contact_id: z.string(),
  assignee_id: z.string(),
  assignee_name: z.string().trim().max(200),
  description: z.string().max(5000),
  comment: z.string().max(3000),
})
type Form = z.infer<typeof schema>
const nul = (v: string) => (v.trim() === '' ? null : v.trim())

/** Создание заявки в отдел оборудования или запчастей */
export function RequestFormModal({ open, onClose, locationId, visitId, defaultKind = 'equipment' }: {
  open: boolean; onClose: () => void; locationId: string; visitId?: string; defaultKind?: 'equipment' | 'parts'
}) {
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const nav = useNavigate()
  const requestId = useRef(crypto.randomUUID())
  const defaults: Form = {
    kind: defaultKind, item_name: '', category_id: '', brand: '', model: '', article: '', quantity: 1, budget: '', urgency: 'normal',
    contact_id: '', assignee_id: '', assignee_name: '', description: '', comment: '',
  }
  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: defaults })
  useEffect(() => {
    if (open) { reset(defaults); requestId.current = crypto.randomUUID() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const kind = watch('kind')

  const contacts = useQuery({
    queryKey: ['location', locationId, 'contacts', 'short'],
    enabled: open,
    queryFn: async () => unwrap(await supabase.from('contacts').select('id,full_name,position,phone').eq('location_id', locationId).is('archived_at', null)) as { id: string; full_name: string | null; position: string | null; phone: string | null }[],
  })

  const mut = useMutation({
    mutationFn: async (v: Form) => {
      const row = {
        kind: v.kind, location_id: locationId, visit_id: visitId ?? null, client_request_id: requestId.current,
        item_name: v.item_name.trim(), category_id: v.kind === 'equipment' ? v.category_id || null : null,
        brand: nul(v.brand), model: v.kind === 'equipment' ? nul(v.model) : null, article: v.kind === 'parts' ? nul(v.article) : null,
        quantity: v.quantity, budget: v.kind === 'equipment' && v.budget !== '' ? v.budget : null, urgency: v.urgency,
        contact_id: v.contact_id || null, assignee_id: v.assignee_id || null, assignee_name: nul(v.assignee_name),
        description: nul(v.description), comment: nul(v.comment),
      }
      const res = await supabase.from('requests').insert(row).select('id, number').single()
      if (res.error?.code === '23505' && String(res.error.message).includes('client_request_id')) {
        return unwrap(await supabase.from('requests').select('id, number').eq('client_request_id', requestId.current).single()) as { id: string; number: string }
      }
      return unwrap(res) as { id: string; number: string }
    },
    onSuccess: (r) => {
      toast.success(`Заявка ${r.number} создана`)
      qc.invalidateQueries({ queryKey: ['requests'] })
      qc.invalidateQueries({ queryKey: ['location', locationId] })
      onClose()
      nav(`/requests/${r.id}`)
    },
    onError: (e) => toast.error(e),
  })
  const submit = handleSubmit((v) => mut.mutate(v))

  return (
    <Modal open={open} onClose={onClose} size="lg" dismissable={!mut.isPending} title="Новая заявка"
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} onClick={submit}>Создать заявку</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit() }} noValidate className="grid gap-3 sm:grid-cols-2">
        <Field label="Отдел" required>
          {(id) => <Select id={id} {...register('kind')}><option value="equipment">Отдел оборудования</option><option value="parts">Отдел запчастей</option></Select>}
        </Field>
        <Field label="Срочность">{(id) => <Select id={id} {...register('urgency')}>{Object.entries(URGENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label={kind === 'equipment' ? 'Оборудование или желаемое решение' : 'Название запчасти'} required error={errors.item_name?.message} className="sm:col-span-2">
          {(id) => <Input id={id} aria-invalid={!!errors.item_name} {...register('item_name')} />}
        </Field>
        {kind === 'equipment' ? (
          <>
            <Field label="Категория оборудования">{(id) => <Select id={id} {...register('category_id')}><option value="">Не указана</option>{d.activeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
            <Field label="Бренд">{(id) => <Input id={id} {...register('brand')} list="brand-options" />}</Field>
            <Field label="Модель">{(id) => <Input id={id} {...register('model')} />}</Field>
            <Field label="Ориентировочный бюджет, ₸" error={errors.budget?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('budget')} />}</Field>
          </>
        ) : (
          <>
            <Field label="Артикул">{(id) => <Input id={id} {...register('article')} />}</Field>
            <Field label="Производитель / бренд">{(id) => <Input id={id} {...register('brand')} list="brand-options" />}</Field>
          </>
        )}
        <Field label="Количество" error={errors.quantity?.message}>{(id) => <Input id={id} type="number" min={1} {...register('quantity')} />}</Field>
        <Field label="Контактное лицо клиента">
          {(id) => <Select id={id} {...register('contact_id')}><option value="">Не указано</option>{contacts.data?.map((c) => <option key={c.id} value={c.id}>{[c.full_name, c.position].filter(Boolean).join(', ') || c.phone}</option>)}</Select>}
        </Field>
        <Field label="Ответственный сотрудник отдела">
          {(id) => <Select id={id} {...register('assignee_id')}><option value="">Не назначен</option>{d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</Select>}
        </Field>
        <Field label="…или имя, если у сотрудника нет учётной записи">{(id) => <Input id={id} {...register('assignee_name')} />}</Field>
        <Field label="Описание потребности" className="sm:col-span-2">{(id) => <Textarea id={id} {...register('description')} />}</Field>
        <Field label="Комментарий" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('comment')} />}</Field>
        <datalist id="brand-options">{d.activeBrands.map((b) => <option key={b.id} value={b.name} />)}</datalist>
        <p className="text-xs text-slate-500 sm:col-span-2">Фото и файлы можно приложить на странице заявки после создания.</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
