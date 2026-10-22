import { useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { usePerms } from '@/auth/AuthProvider'
import type { Deal } from '@/lib/types'

const schema = z.object({
  title: z.string().trim().min(2, 'Укажите название сделки').max(300),
  product: z.string().trim().max(300),
  amount: z.union([z.literal(''), z.coerce.number().min(0, 'Не меньше 0').max(1e12)]),
  stage_code: z.string().min(1),
  probability: z.union([z.literal(''), z.coerce.number().int().min(0, '0–100').max(100, '0–100')]),
  expected_close_date: z.string(),
  source: z.string().trim().max(200),
  request_id: z.string(),
  manager_id: z.string(),
  next_step: z.string().max(1000),
  next_action_date: z.string(),
  lost_reason: z.string().max(1000),
  comment: z.string().max(3000),
})
type Form = z.infer<typeof schema>
const nul = (v: string) => (v.trim() === '' ? null : v.trim())

/** Создание и редактирование потенциальной сделки */
export function DealFormModal({ open, onClose, locationId, visitId, deal }: { open: boolean; onClose: () => void; locationId: string; visitId?: string; deal?: Deal | null }) {
  const d = useDicts()
  const perms = usePerms()
  const qc = useQueryClient()
  const toast = useToast()
  const requestId = useRef(crypto.randomUUID())
  const defaults = (): Form => ({
    title: deal?.title ?? '', product: deal?.product ?? '', amount: deal?.amount ?? '', stage_code: deal?.stage_code ?? 'need',
    probability: deal?.probability ?? '', expected_close_date: deal?.expected_close_date ?? '', source: deal?.source ?? (visitId ? 'Визит' : ''),
    request_id: deal?.request_id ?? '', manager_id: deal?.manager_id ?? '', next_step: deal?.next_step ?? '', next_action_date: deal?.next_action_date ?? '',
    lost_reason: deal?.lost_reason ?? '', comment: deal?.comment ?? '',
  })
  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: defaults() })
  useEffect(() => {
    if (open) { reset(defaults()); requestId.current = crypto.randomUUID() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deal?.id])
  const stage = watch('stage_code')
  const lost = d.dealStage(stage)?.kind === 'lost'

  const requests = useQuery({
    queryKey: ['location', locationId, 'requests', 'short'],
    enabled: open,
    queryFn: async () => unwrap(await supabase.from('requests').select('id,number,item_name').eq('location_id', locationId).order('created_at', { ascending: false }).limit(50)) as { id: string; number: string; item_name: string }[],
  })

  const mut = useMutation({
    mutationFn: async (v: Form) => {
      if (lost && !v.lost_reason.trim()) throw new Error('Для проигранной сделки укажите причину проигрыша')
      const row = {
        title: v.title.trim(), product: nul(v.product), amount: v.amount === '' ? null : v.amount, stage_code: v.stage_code,
        probability: v.probability === '' ? null : v.probability, expected_close_date: v.expected_close_date || null, source: nul(v.source),
        request_id: v.request_id || null, next_step: nul(v.next_step), next_action_date: v.next_action_date || null,
        lost_reason: lost ? nul(v.lost_reason) : null, comment: nul(v.comment),
        ...(perms.assign && v.manager_id ? { manager_id: v.manager_id } : {}),
      }
      if (deal) {
        const rows = unwrap(await supabase.from('deals').update(row).eq('id', deal.id).select('id'))
        if (!rows?.length) throw new Error('Недостаточно прав')
        return
      }
      const res = await supabase.from('deals').insert({ ...row, location_id: locationId, visit_id: visitId ?? null, client_request_id: requestId.current }).select('id')
      if (res.error?.code === '23505' && String(res.error.message).includes('client_request_id')) return
      unwrap(res)
    },
    onSuccess: () => {
      toast.success(deal ? 'Сделка обновлена' : 'Сделка создана')
      qc.invalidateQueries({ queryKey: ['deals'] })
      qc.invalidateQueries({ queryKey: ['location', locationId] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })
  const submit = handleSubmit((v) => mut.mutate(v))

  return (
    <Modal open={open} onClose={onClose} size="lg" dismissable={!mut.isPending} title={deal ? 'Потенциальная сделка' : 'Новая потенциальная сделка'}
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} onClick={submit}>Сохранить</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit() }} noValidate className="grid gap-3 sm:grid-cols-2">
        <Field label="Название сделки" required error={errors.title?.message} className="sm:col-span-2">{(id) => <Input id={id} aria-invalid={!!errors.title} {...register('title')} placeholder="Например: подъёмник и балансировочный станок" />}</Field>
        <Field label="Предполагаемый товар / оборудование" className="sm:col-span-2">{(id) => <Input id={id} {...register('product')} />}</Field>
        <Field label="Предполагаемая сумма, ₸" error={errors.amount?.message} hint="Оценка, не выручка">{(id) => <Input id={id} inputMode="numeric" {...register('amount')} />}</Field>
        <Field label="Стадия">{(id) => <Select id={id} {...register('stage_code')}>{d.dealStages.filter((s) => s.is_active || s.code === deal?.stage_code).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>}</Field>
        {lost && <Field label="Причина проигрыша" required className="sm:col-span-2">{(id) => <Input id={id} {...register('lost_reason')} />}</Field>}
        <Field label="Вероятность, %" error={errors.probability?.message} hint="Необязательно">{(id) => <Input id={id} inputMode="numeric" {...register('probability')} />}</Field>
        <Field label="Ожидаемая дата закрытия">{(id) => <Input id={id} type="date" {...register('expected_close_date')} />}</Field>
        <Field label="Источник сделки">{(id) => <Input id={id} {...register('source')} placeholder="Визит, звонок, выставка…" />}</Field>
        <Field label="Связанная заявка">{(id) => <Select id={id} {...register('request_id')}><option value="">Нет</option>{requests.data?.map((r) => <option key={r.id} value={r.id}>{r.number} — {r.item_name}</option>)}</Select>}</Field>
        {perms.assign && (
          <Field label="Ответственный">{(id) => <Select id={id} {...register('manager_id')}><option value="">{deal ? 'Не менять' : 'Я'}</option>{d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</Select>}</Field>
        )}
        <Field label="Следующий шаг" className="sm:col-span-2">{(id) => <Input id={id} {...register('next_step')} />}</Field>
        <Field label="Дата следующего действия">{(id) => <Input id={id} type="date" {...register('next_action_date')} />}</Field>
        <Field label="Комментарий" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('comment')} />}</Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
