import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Checkbox, Field, Input, QueryState, Select, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { REQUEST_DEPT_LABEL } from '@/lib/labels'
import { bitrixToast, sendToBitrix } from '@/lib/bitrix'

interface Cfg {
  enabled: boolean
  entity: 'lead' | 'deal'
  source_name: string
  source_id: string
  kinds: Record<string, { assigned_by_id: string; category_id: string }>
}
const KINDS = ['service', 'parts', 'equipment'] as const
const EMPTY: Cfg = {
  enabled: true, entity: 'lead', source_name: 'Торговый представитель', source_id: '',
  kinds: { service: { assigned_by_id: '', category_id: '' }, parts: { assigned_by_id: '', category_id: '' }, equipment: { assigned_by_id: '', category_id: '' } },
}

/** Настройки отправки заявок в Битрикс24. Адрес вебхука — только в секретах Supabase. */
export function BitrixTab() {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({
    queryKey: ['app-settings', 'bitrix'],
    queryFn: async () => (unwrap(await supabase.from('app_settings').select('value').eq('key', 'bitrix').maybeSingle()) as { value: Cfg } | null)?.value ?? null,
  })
  const [cfg, setCfg] = useState<Cfg>(EMPTY)
  useEffect(() => {
    if (q.data) setCfg({ ...EMPTY, ...q.data, kinds: { ...EMPTY.kinds, ...(q.data.kinds ?? {}) } })
  }, [q.data])
  const [test, setTest] = useState<{ source_id: string; sources: { id: string; name: string }[]; categories: { id: number; name: string }[] } | null>(null)

  const save = useMutation({
    mutationFn: async () => unwrap(await supabase.from('app_settings').upsert({ key: 'bitrix', value: cfg }).select('key')),
    onSuccess: () => { toast.success('Настройки Битрикс24 сохранены'); qc.invalidateQueries({ queryKey: ['app-settings'] }) },
    onError: (e) => toast.error(e),
  })
  const check = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('bitrix', { body: { action: 'test' } })
      if (error) {
        let msg = ''
        try { msg = (await (error as { context?: Response }).context?.json())?.error ?? '' } catch { msg = '' }
        throw new Error(msg || 'Функция bitrix не развёрнута в Supabase')
      }
      return data
    },
    onSuccess: (d) => { setTest(d); toast.success(`Соединение с Битрикс24 работает. Источник: ${d.source_id}`) },
    onError: (e) => toast.error(e),
  })
  const pending = useMutation({
    mutationFn: () => sendToBitrix({ action: 'send_pending' }),
    onSuccess: (b) => {
      const t = bitrixToast(b)
      if (b.disabled) toast.error('Интеграция не настроена')
      else if (t?.ok) toast.success(t.ok)
      else if (t?.error) toast.error(t.error)
      else toast.success('Неотправленных заявок нет')
      qc.invalidateQueries({ queryKey: ['requests'] })
    },
    onError: (e) => toast.error(e),
  })
  const setKind = (k: string, f: 'assigned_by_id' | 'category_id', v: string) =>
    setCfg((c) => ({ ...c, kinds: { ...c.kinds, [k]: { ...c.kinds[k], [f]: v.replace(/\D/g, '') } } }))

  return (
    <QueryState query={q}>
      <div className="max-w-4xl space-y-4">
        <Card title="Подключение">
          <ol className="list-inside list-decimal space-y-1 text-sm text-slate-700">
            <li>В Битрикс24: <b>Разработчикам → Другое → Входящий вебхук</b>, права <b>CRM</b>. Скопируйте адрес вида <code>https://компания.bitrix24.kz/rest/1/…/</code>.</li>
            <li>В Supabase: <b>Edge Functions → Secrets</b> → секрет <code>BITRIX_WEBHOOK_URL</code> с этим адресом. Адрес — это ключ доступа, в CRM он не хранится.</li>
            <li>В Supabase: функция <code>bitrix</code> развёрнута, «Verify JWT» выключен.</li>
            <li>Нажмите «Проверить соединение».</li>
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button loading={check.isPending} onClick={() => check.mutate()}>Проверить соединение</Button>
            <Button loading={pending.isPending} onClick={() => pending.mutate()}>Отправить неотправленные заявки</Button>
          </div>
          {test && (
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div><b>Источники в Битриксе</b><ul className="mt-1 text-slate-600">{test.sources.map((s) => <li key={s.id}><code>{s.id}</code> — {s.name}</li>)}</ul></div>
              {!!test.categories.length && <div><b>Воронки сделок</b><ul className="mt-1 text-slate-600">{test.categories.map((c) => <li key={c.id}><code>{c.id}</code> — {c.name}</li>)}</ul></div>}
            </div>
          )}
        </Card>

        <Card title="Что создавать">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Checkbox label="Отправлять новые заявки в Битрикс24" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /></div>
            <Field label="Тип записи в Битриксе">
              {(id) => <Select id={id} value={cfg.entity} onChange={(e) => setCfg({ ...cfg, entity: e.target.value as Cfg['entity'] })}><option value="lead">Лид</option><option value="deal">Сделка</option></Select>}
            </Field>
            <Field label="Источник" hint="Если такого нет в Битриксе — создастся сам (или «Другое», если у вебхука нет прав)">
              {(id) => <Input id={id} value={cfg.source_name} onChange={(e) => setCfg({ ...cfg, source_name: e.target.value })} />}
            </Field>
            <Field label="Код источника (необязательно)" hint="Например UC_7K2 — из списка после проверки соединения">
              {(id) => <Input id={id} value={cfg.source_id} onChange={(e) => setCfg({ ...cfg, source_id: e.target.value.trim() })} />}
            </Field>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>Отдел</th><th>ID ответственного в Битриксе</th>{cfg.entity === 'deal' && <th>ID воронки</th>}</tr></thead>
              <tbody>
                {KINDS.map((k) => (
                  <tr key={k}>
                    <td>{REQUEST_DEPT_LABEL[k]}</td>
                    <td><Input className="w-40" inputMode="numeric" placeholder="по правилам Битрикса" value={cfg.kinds[k]?.assigned_by_id ?? ''} onChange={(e) => setKind(k, 'assigned_by_id', e.target.value)} aria-label={`Ответственный: ${REQUEST_DEPT_LABEL[k]}`} /></td>
                    {cfg.entity === 'deal' && <td><Input className="w-32" inputMode="numeric" placeholder="0 — общая" value={cfg.kinds[k]?.category_id ?? ''} onChange={(e) => setKind(k, 'category_id', e.target.value)} aria-label={`Воронка: ${REQUEST_DEPT_LABEL[k]}`} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">ID сотрудника видно в адресе его профиля в Битриксе: …/company/personal/user/<b>15</b>/</p>
          <div className="mt-3 flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button></div>
        </Card>
      </div>
    </QueryState>
  )
}
