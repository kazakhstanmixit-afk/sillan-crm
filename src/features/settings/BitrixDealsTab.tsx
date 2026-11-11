import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyX, PlugZap, Send } from 'lucide-react'
import { Button, Card, Checkbox, Field, Input, QueryState, Select, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { callBitrix } from '@/lib/bitrix'

type Kind = 'service' | 'parts' | 'equipment'
type FieldKey = 'source' | 'city' | 'need' | 'count' | 'whatsapp'
interface Cfg {
  enabled?: boolean
  create_company?: boolean
  crm_url?: string
  portal_url?: string
  kinds?: Partial<Record<Kind, { category_id?: string; assigned_ids?: string; assign_rep?: boolean }>>
  fields?: Partial<Record<FieldKey | 'source_value', string>>
}
interface Portal {
  user: { id: string; name: string } | null
  portal_url: string
  categories: { id: string; name: string }[]
  fields: { code: string; title: string; type: string; items: { id: string; value: string }[] }[]
  guess: Record<FieldKey | 'source_value', string>
}

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'service', label: 'Сервис' },
  { kind: 'parts', label: 'Запчасти' },
  { kind: 'equipment', label: 'Продажа оборудования' },
]
const FIELDS: { key: FieldKey; label: string; hint: string }[] = [
  { key: 'source', label: 'Источник', hint: 'Поле «Источник Маркетинг»' },
  { key: 'city', label: 'Город', hint: 'Город точки' },
  { key: 'need', label: 'Потребность в товаре', hint: 'Список позиций заявок' },
  { key: 'count', label: 'Количество товарных позиций', hint: 'Сколько заявок в сделке' },
  { key: 'whatsapp', label: 'Whatsapp', hint: 'WhatsApp или телефон ЛПР' },
]
const FUNCTION_URL = `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1/bitrix`

/** Заявки → сделки Битрикс24 в воронках отделов */
export function BitrixDealsTab() {
  const qc = useQueryClient()
  const toast = useToast()
  const cfgQ = useQuery({
    queryKey: ['app_settings', 'bitrix_deals'],
    queryFn: async () => ((unwrap(await supabase.from('app_settings').select('value').eq('key', 'bitrix_deals').maybeSingle()) as { value: Cfg } | null)?.value ?? {}),
  })
  const stats = useQuery({
    queryKey: ['bitrix_deals_stats'],
    queryFn: async () => unwrap(await supabase.rpc('bitrix_deals_stats')) as { pending: number; sent: number; error: number; last_error: string | null },
  })
  const [cfg, setCfg] = useState<Cfg>({})
  const [portal, setPortal] = useState<Portal | null>(null)
  const [progress, setProgress] = useState('')
  useEffect(() => { if (cfgQ.data) setCfg(cfgQ.data) }, [cfgQ.data])

  const setKind = (k: Kind, patch: { category_id?: string; assigned_ids?: string; assign_rep?: boolean }) =>
    setCfg((c) => ({ ...c, kinds: { ...c.kinds, [k]: { ...c.kinds?.[k], ...patch } } }))
  const setField = (k: FieldKey | 'source_value', v: string) => setCfg((c) => ({ ...c, fields: { ...c.fields, [k]: v } }))

  const test = useMutation({
    mutationFn: async () => {
      const r = await callBitrix({ action: 'test' })
      if (r.error) throw Object.assign(new Error(r.error), { code: 'P0001' })
      return r as unknown as Portal
    },
    onSuccess: (p) => {
      setPortal(p)
      // поля формы, которые ещё не выбраны, — подставить найденные по названиям
      setCfg((c) => {
        const f = { ...c.fields }
        for (const [k, v] of Object.entries(p.guess)) if (!f[k as FieldKey] && v) f[k as FieldKey] = v
        return { ...c, portal_url: p.portal_url, fields: f }
      })
      toast.success(`Соединение есть${p.user ? `: вебхук пользователя ${p.user.name} (ID ${p.user.id})` : ''}`)
    },
    onError: (e) => toast.error(e),
  })

  const save = useMutation({
    mutationFn: async () => {
      const value = { ...cfg, crm_url: window.location.origin }
      unwrap(await supabase.from('app_settings').upsert({ key: 'bitrix_deals', value, updated_at: new Date().toISOString() }))
      unwrap(await supabase.rpc('setup_bitrix_sync', { p_function_url: FUNCTION_URL, p_enabled: !!cfg.enabled }))
    },
    onSuccess: () => {
      toast.success(cfg.enabled ? 'Сохранено: новые заявки уходят в Битрикс24, неотправленные досылаются каждые 10 минут' : 'Сохранено: отправка выключена')
      qc.invalidateQueries({ queryKey: ['app_settings'] })
    },
    onError: (e) => toast.error(e),
  })

  const sendAll = useMutation({
    mutationFn: async () => {
      let total = 0
      const errors: string[] = []
      for (let i = 0; i < 40; i++) {
        const r = await callBitrix({ action: 'sync_pending' })
        if (r.error) throw Object.assign(new Error(r.error), { code: 'P0001' })
        if (r.disabled) throw Object.assign(new Error('Сначала включите отправку и сохраните настройки'), { code: 'P0001' })
        total += r.sent ?? 0
        errors.push(...(r.errors ?? []))
        setProgress(`Отправлено сделок: ${total}${r.left ? `, осталось: ${r.left}` : ''}`)
        if (!r.left || !(r.sent ?? 0)) break
      }
      return { total, errors }
    },
    onSuccess: ({ total, errors }) => {
      if (errors.length) toast.error(Object.assign(new Error(`Отправлено ${total}, ошибок ${errors.length}: ${errors[0]}`), { code: 'P0001' }))
      else toast.success(total ? `Отправлено сделок: ${total}` : 'Всё уже отправлено')
      qc.invalidateQueries({ queryKey: ['bitrix_deals_stats'] })
    },
    onError: (e) => toast.error(e),
    onSettled: () => setProgress(''),
  })

  type Dup = { ID: string; TITLE: string; DATE_CREATE: string }
  const [dups, setDups] = useState<Dup[] | null>(null)
  const findDups = useMutation({
    mutationFn: async () => {
      const r = await callBitrix({ action: 'duplicates' })
      if (r.error) throw Object.assign(new Error(r.error), { code: 'P0001' })
      return r as unknown as { total: number; duplicates: Dup[] }
    },
    onSuccess: (r) => { setDups(r.duplicates); if (!r.duplicates.length) toast.success(`Дублей нет (сделок из CRM в Битриксе: ${r.total})`) },
    onError: (e) => toast.error(e),
  })
  const delDups = useMutation({
    mutationFn: async () => {
      const r = await callBitrix({ action: 'delete_duplicates', ids: (dups ?? []).map((d) => d.ID) })
      if (r.error) throw Object.assign(new Error(r.error), { code: 'P0001' })
      return r as unknown as { deleted: number; errors: string[] }
    },
    onSuccess: (r) => {
      if (r.errors.length) toast.error(Object.assign(new Error(`Удалено ${r.deleted}, не удалось: ${r.errors[0]}`), { code: 'P0001' }))
      else toast.success(`Удалено дублей: ${r.deleted}`)
      setDups(null)
    },
    onError: (e) => toast.error(e),
  })
  const portalUrl = (cfgQ.data?.portal_url ?? cfg.portal_url ?? '').replace(/\/$/, '')

  const catOptions = portal?.categories ?? []
  const fieldOptions = portal?.fields ?? []
  const sourceField = fieldOptions.find((f) => f.code === cfg.fields?.source)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Заявки → сделки Битрикс24">
        <QueryState query={cfgQ}>
          <div className="space-y-4 text-sm">
            <p className="text-slate-600">Заявки одного клиента в один отдел за один день собираются в одну сделку: позиции — товарами и списком в комментарии. Новая заявка в тот же день дописывается в ту же сделку.</p>
            <div className="flex flex-wrap gap-2">
              <Button icon={<PlugZap className="size-4" />} loading={test.isPending} onClick={() => test.mutate()}>Проверить соединение</Button>
              {portal?.user && <span className="self-center text-emerald-700">Вебхук: {portal.user.name}, ID {portal.user.id}</span>}
            </div>
            <Checkbox label="Отправлять заявки в Битрикс24" checked={!!cfg.enabled} onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))} />
            <Checkbox label="Создавать компанию и контакт (ищет по телефону и названию, чтобы не было дублей)" checked={cfg.create_company !== false} onChange={(e) => setCfg((c) => ({ ...c, create_company: e.target.checked }))} />

            <div className="space-y-3">
              <h3 className="font-semibold">Воронки и ответственные</h3>
              {KINDS.map(({ kind, label }) => (
                <div key={kind} className="grid gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
                  <Field label={`${label}: воронка`}>
                    {(id) => catOptions.length
                      ? <Select id={id} value={cfg.kinds?.[kind]?.category_id ?? ''} onChange={(e) => setKind(kind, { category_id: e.target.value })}>
                          <option value="">— выберите —</option>
                          {catOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </Select>
                      : <Input id={id} value={cfg.kinds?.[kind]?.category_id ?? ''} placeholder="Нажмите «Проверить соединение»" readOnly />}
                  </Field>
                  <Field label="Менеджеры (ID через запятую)" hint={cfg.kinds?.[kind]?.assign_rep ? 'Если у торгового не указан ID в Битрикс24' : 'По очереди; тот же клиент — тому же менеджеру'}>
                    {(id) => <Input id={id} value={cfg.kinds?.[kind]?.assigned_ids ?? ''} onChange={(e) => setKind(kind, { assigned_ids: e.target.value.replace(/[^\d,\s]/g, '') })} placeholder="Например: 15, 22, 31" />}
                  </Field>
                  <div className="sm:col-span-2">
                    <Checkbox label="Ответственный — торговый представитель, создавший заявку" checked={!!cfg.kinds?.[kind]?.assign_rep} onChange={(e) => setKind(kind, { assign_rep: e.target.checked })} />
                  </div>
                </div>
              ))}
              <p className="text-xs text-slate-500">ID менеджера — число в адресе его профиля в Битрикс24: …/company/personal/user/<b>70</b>/. Если менеджеров не указать — ответственным станет владелец вебхука.</p>
            </div>

            <div className="space-y-3">
              <h3 className="font-semibold">Поля формы сделки</h3>
              {!fieldOptions.length && <p className="text-slate-500">Нажмите «Проверить соединение» — поля подберутся по названиям сами.</p>}
              {fieldOptions.length > 0 && FIELDS.map(({ key, label, hint }) => (
                <Field key={key} label={label} hint={hint}>
                  {(id) => (
                    <Select id={id} value={cfg.fields?.[key] ?? ''} onChange={(e) => setField(key, e.target.value)}>
                      <option value="">— не заполнять —</option>
                      {fieldOptions.map((f) => <option key={f.code} value={f.code}>{f.title}</option>)}
                    </Select>
                  )}
                </Field>
              ))}
              {sourceField && sourceField.items.length > 0 && (
                <Field label="Значение источника">
                  {(id) => (
                    <Select id={id} value={cfg.fields?.source_value ?? ''} onChange={(e) => setField('source_value', e.target.value)}>
                      <option value="">Торговый представитель</option>
                      {sourceField.items.map((i) => <option key={i.id} value={i.value}>{i.value}</option>)}
                    </Select>
                  )}
                </Field>
              )}
            </div>

            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button>
          </div>
        </QueryState>
      </Card>

      <div className="space-y-4">
        <Card title="Отправка">
          <QueryState query={stats}>
            {stats.data && (
              <div className="space-y-3 text-sm">
                <p>Отправлено сделок: <b>{stats.data.sent}</b> · ждут отправки: <b>{stats.data.pending}</b> · с ошибкой: <b className={stats.data.error ? 'text-red-700' : ''}>{stats.data.error}</b></p>
                {stats.data.last_error && <p className="text-red-700">Последняя ошибка: {stats.data.last_error}</p>}
                <Button icon={<Send className="size-4" />} loading={sendAll.isPending} disabled={!cfgQ.data?.enabled} onClick={() => sendAll.mutate()}>Отправить неотправленные</Button>
                {progress && <p className="text-slate-500">{progress}</p>}
                <p className="text-xs text-slate-500">Новые заявки уходят сразу после создания. Если Битрикс был недоступен — CRM досылает каждые 10 минут.</p>
                <div className="border-t border-slate-100 pt-3">
                  <Button size="sm" icon={<CopyX className="size-4" />} loading={findDups.isPending} onClick={() => findDups.mutate()}>Найти дубли сделок</Button>
                  {dups && dups.length > 0 && (
                    <div className="mt-2 space-y-2">
                      <p>Найдено дублей: <b>{dups.length}</b>. Это копии сделок, которые CRM уже отправила (то же название и компания). Оригиналы остаются.</p>
                      <ul className="max-h-48 space-y-0.5 overflow-auto text-xs">
                        {dups.map((d) => (
                          <li key={d.ID}>
                            {portalUrl ? <a className="text-brand-700 hover:underline" href={`${portalUrl}/crm/deal/details/${d.ID}/`} target="_blank" rel="noreferrer">№{d.ID}</a> : `№${d.ID}`} — {d.TITLE}
                          </li>
                        ))}
                      </ul>
                      <Button size="sm" variant="danger" loading={delDups.isPending} onClick={() => { if (window.confirm(`Удалить ${dups.length} дублей в Битрикс24? Оригиналы останутся.`)) delDups.mutate() }}>Удалить дубли ({dups.length})</Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </QueryState>
        </Card>
        <RepsBitrixCard />
        <Card title="Как подключить (один раз)">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-600">
            <li>Битрикс24 → Разработчикам → Интеграции → ваш входящий вебхук → в «Настройке прав» добавьте <b>«CRM (crm)»</b> → Сохранить. Можно тот же вебхук, что для отчёта.</li>
            <li>Если это другой вебхук — Supabase → Edge Functions → Secrets → <code>BITRIX_WEBHOOK_URL</code> = его адрес. Если тот же — ничего не нужно.</li>
            <li>Supabase → Edge Functions → создайте функцию <code>bitrix</code>, вставьте код из <code>supabase/functions/bitrix/index.ts</code> → Deploy → Details → выключите «Verify JWT».</li>
            <li>Здесь: «Проверить соединение» → выберите воронки, впишите ID менеджеров → галочка «Отправлять» → «Сохранить» → «Отправить неотправленные».</li>
          </ol>
        </Card>
      </div>
    </div>
  )
}

/** ID торговых представителей в Битрикс24 — чтобы назначать их ответственными по своим сделкам */
function RepsBitrixCard() {
  const qc = useQueryClient()
  const toast = useToast()
  const reps = useQuery({
    queryKey: ['reps_bitrix'],
    queryFn: async () => unwrap(await supabase.from('profiles').select('id, full_name, bitrix_user_id').eq('role', 'rep').eq('is_active', true).order('full_name')) as { id: string; full_name: string; bitrix_user_id: string | null }[],
  })
  const [vals, setVals] = useState<Record<string, string>>({})
  useEffect(() => { if (reps.data) setVals(Object.fromEntries(reps.data.map((r) => [r.id, r.bitrix_user_id ?? '']))) }, [reps.data])
  const save = useMutation({
    mutationFn: async () => {
      for (const r of reps.data ?? []) {
        if ((vals[r.id] ?? '') !== (r.bitrix_user_id ?? '')) unwrap(await supabase.rpc('set_profile_bitrix_id', { p_user: r.id, p_bitrix_id: vals[r.id] ?? '' }))
      }
    },
    onSuccess: () => { toast.success('ID торговых сохранены'); qc.invalidateQueries({ queryKey: ['reps_bitrix'] }) },
    onError: (e) => toast.error(e),
  })
  return (
    <Card title="Торговые представители в Битрикс24">
      <QueryState query={reps}>
        <div className="space-y-2 text-sm">
          <p className="text-slate-500">ID — число в адресе профиля в Битрикс24: …/company/personal/user/<b>70</b>/. Нужно, если у воронки стоит «Ответственный — торговый».</p>
          {(reps.data ?? []).map((r) => (
            <Field key={r.id} label={r.full_name}>
              {(id) => <Input id={id} value={vals[r.id] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [r.id]: e.target.value.replace(/\D/g, '') }))} inputMode="numeric" placeholder="ID в Битрикс24" />}
            </Field>
          ))}
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить ID</Button>
        </div>
      </QueryState>
    </Card>
  )
}
