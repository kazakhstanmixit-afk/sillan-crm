import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Card, ChipSelect, Field, Input, PageHeader, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { usePerms } from '@/auth/AuthProvider'
import { splitPhones } from '@/lib/phone'
import { DECISION_ROLE_LABEL } from '@/lib/labels'
import { CompanyPicker, type CompanyChoice } from './CompanyPicker'

const optInt = z.union([z.literal(''), z.coerce.number().int('Целое число').min(0, 'Не меньше 0').max(500, 'Слишком большое значение')])

export const newClientSchema = z.object({
  name: z.string().trim().min(2, 'Укажите название (не короче 2 символов)').max(200),
  client_type: z.string().max(100),
  status_code: z.string().min(1),
  city: z.string().trim().max(100),
  district: z.string().trim().max(100),
  address: z.string().trim().max(300),
  address_note: z.string().max(500),
  phones: z.string().max(300),
  website: z.string().trim().max(200),
  posts_count: optInt,
  lifts_count: optInt,
  direction_ids: z.array(z.string()),
  manager_id: z.string(),
  contact_name: z.string().trim().max(200),
  contact_position: z.string().trim().max(100),
  contact_phone: z.string().trim().max(50),
  contact_role: z.string(),
  comment: z.string().max(3000),
  bin: z.union([z.literal(''), z.string().regex(/^\d{12}$/, 'БИН — 12 цифр')]),
  legal_name: z.string().max(200),
})
type Form = z.infer<typeof newClientSchema>

export default function ClientNewPage() {
  const d = useDicts()
  const perms = usePerms()
  const nav = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const requestId = useRef(crypto.randomUUID())
  const [company, setCompany] = useState<CompanyChoice>({ kind: 'none' })

  const { register, handleSubmit, control, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(newClientSchema),
    defaultValues: {
      name: '', client_type: '', status_code: 'new', city: '', district: '', address: '', address_note: '', phones: '', website: '',
      posts_count: '', lifts_count: '', direction_ids: [], manager_id: '', contact_name: '', contact_position: '', contact_phone: '',
      contact_role: '', comment: '', bin: '', legal_name: '',
    },
  })

  const mut = useMutation({
    mutationFn: async (v: Form) =>
      unwrap(await supabase.rpc('create_location', {
        p: {
          client_request_id: requestId.current,
          name: v.name,
          client_type: v.client_type,
          status_code: v.status_code,
          city: v.city,
          district: v.district,
          address: v.address,
          address_note: v.address_note,
          phones: splitPhones(v.phones),
          website: v.website,
          posts_count: v.posts_count === '' ? null : v.posts_count,
          lifts_count: v.lifts_count === '' ? null : v.lifts_count,
          direction_ids: v.direction_ids,
          manager_id: v.manager_id || null,
          company_id: company.kind === 'existing' ? company.id : null,
          new_company: company.kind === 'new' ? { name: company.name, legal_name: v.legal_name, bin: v.bin } : null,
          contact: { full_name: v.contact_name, position: v.contact_position, phone: v.contact_phone, decision_role: v.contact_role },
          comment: v.comment,
        },
      })) as string,
    onSuccess: (id) => {
      toast.success('Клиент добавлен')
      qc.invalidateQueries({ queryKey: ['clients'] })
      nav(`/clients/${id}`, { replace: true })
    },
    onError: (e) => toast.error(e),
  })

  return (
    <form onSubmit={handleSubmit((v) => mut.mutate(v))} noValidate className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Новый клиент" subtitle="Физическая точка обслуживания. Компания (юрлицо) — по желанию." />

      <Card title="Основное">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Название точки" required error={errors.name?.message} className="sm:col-span-2">
            {(id) => <Input id={id} aria-invalid={!!errors.name} {...register('name')} placeholder="Например: СТО «Мотор» на Абая" />}
          </Field>
          <Field label="Компания / юрлицо" className="sm:col-span-2" hint="Несколько точек могут принадлежать одной компании">
            {() => <CompanyPicker value={company} onChange={setCompany} />}
          </Field>
          {company.kind === 'new' && (
            <>
              <Field label="Юридическое название" error={errors.legal_name?.message}>{(id) => <Input id={id} {...register('legal_name')} placeholder="ТОО «…»" />}</Field>
              <Field label="БИН" error={errors.bin?.message}>{(id) => <Input id={id} inputMode="numeric" aria-invalid={!!errors.bin} {...register('bin')} />}</Field>
            </>
          )}
          <Field label="Статус">
            {(id) => <Select id={id} {...register('status_code')}>{d.clientStatuses.filter((s) => s.is_active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>}
          </Field>
          {perms.assign && (
            <Field label="Ответственный менеджер">
              {(id) => (
                <Select id={id} {...register('manager_id')}>
                  <option value="">Не назначен</option>
                  {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
                </Select>
              )}
            </Field>
          )}
        </div>
      </Card>

      <Card title="Направления деятельности">
        <Controller control={control} name="direction_ids" render={({ field }) => (
          <ChipSelect options={d.activeDirections.map((x) => ({ value: x.id, label: x.name }))} value={field.value} onChange={field.onChange} />
        )} />
      </Card>

      <Card title="Расположение и связь">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Город" error={errors.city?.message}>{(id) => <Input id={id} {...register("city")} />}</Field>
          <Field label="Район">{(id) => <Input id={id} {...register('district')} />}</Field>
          <Field label="Фактический адрес" className="sm:col-span-2" hint="Сохраняется как адрес, подтверждённый менеджером">
            {(id) => <Input id={id} {...register('address')} />}
          </Field>
          <Field label="Как найти" className="sm:col-span-2">{(id) => <Input id={id} {...register('address_note')} placeholder="Ориентир, въезд со двора и т.п." />}</Field>
          <Field label="Телефоны точки" hint="Несколько — через запятую">{(id) => <Input id={id} type="tel" {...register('phones')} />}</Field>
          <Field label="Сайт">{(id) => <Input id={id} {...register('website')} />}</Field>
          <Field label="Рабочих постов" error={errors.posts_count?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('posts_count')} />}</Field>
          <Field label="Подъёмников" error={errors.lifts_count?.message}>{(id) => <Input id={id} inputMode="numeric" {...register('lifts_count')} />}</Field>
        </div>
      </Card>

      <Card title="Контактное лицо (если известно)">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="ФИО">{(id) => <Input id={id} {...register('contact_name')} />}</Field>
          <Field label="Должность">{(id) => <Input id={id} {...register('contact_position')} />}</Field>
          <Field label="Телефон">{(id) => <Input id={id} type="tel" {...register('contact_phone')} />}</Field>
          <Field label="Роль в принятии решения">
            {(id) => (
              <Select id={id} {...register('contact_role')}>
                <option value="">Не указано</option>
                {Object.entries(DECISION_ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card title="Комментарий">
        <Textarea {...register('comment')} placeholder="Первое впечатление, договорённости, особенности точки" aria-label="Комментарий" />
      </Card>

      <div className="flex justify-end gap-2 pb-6">
        <Button onClick={() => nav(-1)} disabled={mut.isPending}>Отмена</Button>
        <Button type="submit" variant="primary" loading={mut.isPending}>Сохранить клиента</Button>
      </div>
    </form>
  )
}
