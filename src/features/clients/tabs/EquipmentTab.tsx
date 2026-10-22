import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Pencil, Plus } from 'lucide-react'
import { Badge, Button, Card, Checkbox, ConfirmDialog, Field, Input, Modal, QueryState, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { fmtDate } from '@/lib/format'
import { CONDITION_LABEL, NEED_LABEL } from '@/lib/labels'
import type { Equipment } from '@/lib/types'
import { clientKeys } from '../api'

const schema = z.object({
  category_id: z.string(),
  brand_id: z.string(),
  new_brand: z.string().trim().max(100),
  name: z.string().trim().min(2, 'Укажите название оборудования').max(200),
  model: z.string().trim().max(100),
  quantity: z.coerce.number().int('Целое число').min(1, 'Минимум 1').max(1000),
  condition: z.string(),
  need: z.string(),
  comment: z.string().max(2000),
})
type Form = z.infer<typeof schema>
const nul = (v: string) => (v.trim() === '' ? null : v.trim())

export function EquipmentTab({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const d = useDicts()
  const key = clientKeys(locationId).equipment
  const [editing, setEditing] = useState<Equipment | 'new' | null>(null)
  const [archiving, setArchiving] = useState<Equipment | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()

  const q = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase.from('location_equipment').select('*').eq('location_id', locationId).order('created_at')) as Equipment[],
  })
  const list = (q.data ?? []).filter((e) => showArchived || !e.archived_at)
  const archive = useMutation({
    mutationFn: async (e: Equipment) => unwrap(await supabase.from('location_equipment').update({ archived_at: new Date().toISOString() }).eq('id', e.id).select('id')),
    onSuccess: () => { toast.success('Оборудование перенесено в архив'); qc.invalidateQueries({ queryKey: key }); setArchiving(null) },
    onError: (e) => toast.error(e),
  })

  return (
    <Card
      title="Оборудование на точке"
      actions={
        <>
          <Checkbox label="Показать архивное" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {canEdit && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>Добавить</Button>}
        </>
      }
      bodyClassName="p-0"
    >
      <QueryState query={q} empty={!list.length} emptyTitle="Оборудование не указано" emptyText="Фиксируйте, что стоит на точке и что клиенту нужно заменить или докупить.">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr><th>Оборудование</th><th>Категория</th><th>Бренд / модель</th><th>Кол-во</th><th>Состояние</th><th>Потребность</th><th>Добавлено</th>{canEdit && <th />}</tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className={e.archived_at ? 'opacity-50' : ''}>
                  <td><div className="font-medium">{e.name}</div>{e.comment && <div className="text-xs text-slate-500">{e.comment}</div>}</td>
                  <td>{d.categoryName(e.category_id)}</td>
                  <td>{[e.brand_id ? d.brandName(e.brand_id) : null, e.model].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="tabular-nums">{e.quantity}</td>
                  <td><Badge color={e.condition === 'working' ? 'green' : e.condition === 'unknown' ? 'gray' : 'amber'}>{CONDITION_LABEL[e.condition]}</Badge></td>
                  <td>{e.need !== 'none' ? <Badge color="violet">{NEED_LABEL[e.need]}</Badge> : <span className="text-slate-400">—</span>}</td>
                  <td className="whitespace-nowrap">{fmtDate(e.created_at)}</td>
                  {canEdit && (
                    <td className="whitespace-nowrap">
                      {!e.archived_at && (
                        <>
                          <Button size="sm" variant="ghost" aria-label="Изменить" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(e)} />
                          <Button size="sm" variant="ghost" aria-label="В архив" icon={<Archive className="size-3.5" />} onClick={() => setArchiving(e)} />
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      {editing && <EquipmentForm locationId={locationId} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!archiving} title="Убрать оборудование?" confirmText="В архив" loading={archive.isPending} onClose={() => setArchiving(null)} onConfirm={() => archiving && archive.mutate(archiving)}>
        «{archiving?.name}» будет перенесено в архив (запись сохранится в истории).
      </ConfirmDialog>
    </Card>
  )
}

function EquipmentForm({ locationId, item, onClose }: { locationId: string; item: Equipment | null; onClose: () => void }) {
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const { register, handleSubmit, watch, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      category_id: item?.category_id ?? '', brand_id: item?.brand_id ?? '', new_brand: '', name: item?.name ?? '', model: item?.model ?? '',
      quantity: item?.quantity ?? 1, condition: item?.condition ?? 'unknown', need: item?.need ?? 'none', comment: item?.comment ?? '',
    },
  })
  const brandId = watch('brand_id')
  const mut = useMutation({
    mutationFn: async (v: Form) => {
      let brand = v.brand_id && v.brand_id !== '__new' ? v.brand_id : null
      if (v.brand_id === '__new' && v.new_brand) {
        const existing = d.brands.find((b) => b.name.trim().toLowerCase() === v.new_brand.toLowerCase())
        brand = existing?.id ?? (unwrap(await supabase.from('equipment_brands').insert({ name: v.new_brand }).select('id').single()) as { id: string }).id
      }
      const row = {
        category_id: v.category_id || null, brand_id: brand, name: v.name.trim(), model: nul(v.model), quantity: v.quantity,
        condition: v.condition, need: v.need, comment: nul(v.comment),
      }
      const res = item
        ? await supabase.from('location_equipment').update(row).eq('id', item.id).select('id')
        : await supabase.from('location_equipment').insert({ ...row, location_id: locationId }).select('id')
      if (!unwrap(res)?.length) throw new Error('Недостаточно прав')
    },
    onSuccess: () => {
      toast.success('Сохранено')
      qc.invalidateQueries({ queryKey: clientKeys(locationId).equipment })
      qc.invalidateQueries({ queryKey: ['dicts'] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })
  const submit = handleSubmit((v) => mut.mutate(v))
  return (
    <Modal open onClose={onClose} dismissable={!mut.isPending} title={item ? 'Изменить оборудование' : 'Добавить оборудование'}
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} onClick={submit}>Сохранить</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit() }} noValidate className="grid gap-3 sm:grid-cols-2">
        <Field label="Название" required error={errors.name?.message} className="sm:col-span-2">{(id) => <Input id={id} aria-invalid={!!errors.name} {...register('name')} placeholder="Например: двухстоечный подъёмник" />}</Field>
        <Field label="Категория">{(id) => <Select id={id} {...register('category_id')}><option value="">Не указана</option>{d.categories.filter((c) => c.is_active || c.id === item?.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label="Бренд">{(id) => (
          <Select id={id} {...register('brand_id')}>
            <option value="">Не указан</option>
            {d.brands.filter((b) => b.is_active || b.id === item?.brand_id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="__new">+ Новый бренд…</option>
          </Select>
        )}</Field>
        {brandId === '__new' && <Field label="Название нового бренда" className="sm:col-span-2">{(id) => <Input id={id} {...register('new_brand')} />}</Field>}
        <Field label="Модель">{(id) => <Input id={id} {...register('model')} />}</Field>
        <Field label="Количество" error={errors.quantity?.message}>{(id) => <Input id={id} type="number" min={1} {...register('quantity')} />}</Field>
        <Field label="Состояние">{(id) => <Select id={id} {...register('condition')}>{Object.entries(CONDITION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label="Потребность">{(id) => <Select id={id} {...register('need')}>{Object.entries(NEED_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label="Комментарий" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} {...register('comment')} />}</Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
