import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { Button, Card, Checkbox, Field, Input, QueryState, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDateTime, todayISO } from '@/lib/format'

type Cfg = { enabled?: boolean; recipient_id?: string; crm_url?: string; last_run_at?: string; last_result?: string }

const FUNCTION_URL = `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1/daily-report`

async function callDailyReport(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('daily-report', { body })
  if (error) {
    let msg = ''
    try { msg = (await (error as { context?: Response }).context?.json())?.error ?? '' } catch { msg = '' }
    if (!msg && /Failed to send|not found|404/i.test(error.message)) {
      msg = 'Функция daily-report не найдена в Supabase или у неё включена проверка JWT — см. инструкцию ниже.'
    }
    throw new Error(msg || error.message)
  }
  if (data?.error) throw new Error(data.error)
  return data as { sent?: boolean; skipped?: string }
}

/** Ежедневный отчёт торговых в личку Битрикс24 */
export function DailyReportTab() {
  const qc = useQueryClient()
  const toast = useToast()
  const [date, setDate] = useState(todayISO())
  const cfg = useQuery({
    queryKey: ['app_settings', 'daily_report'],
    queryFn: async () => {
      const row = unwrap(await supabase.from('app_settings').select('value').eq('key', 'daily_report').maybeSingle()) as { value: Cfg } | null
      return row?.value ?? {}
    },
  })
  const preview = useQuery({
    queryKey: ['daily_report_preview', date],
    queryFn: async () => unwrap(await supabase.rpc('daily_report_preview', { p_date: date })) as string | null,
  })
  const [enabled, setEnabled] = useState(false)
  const [recipient, setRecipient] = useState('')
  useEffect(() => {
    if (cfg.data) { setEnabled(!!cfg.data.enabled); setRecipient(cfg.data.recipient_id ?? '') }
  }, [cfg.data])

  const save = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('setup_daily_report', {
      p_function_url: FUNCTION_URL, p_enabled: enabled, p_recipient_id: recipient.trim(), p_crm_url: window.location.origin,
    })),
    onSuccess: () => {
      toast.success(enabled ? 'Сохранено: отчёт будет уходить каждый день в 19:00' : 'Сохранено: ежедневная отправка выключена')
      qc.invalidateQueries({ queryKey: ['app_settings'] })
    },
    onError: (e) => toast.error(e),
  })
  const send = useMutation({
    mutationFn: () => callDailyReport({ date }),
    onSuccess: (r) => { r.sent ? toast.success('Отчёт отправлен в Битрикс24') : toast.success(r.skipped ?? 'Не отправлено'); qc.invalidateQueries({ queryKey: ['app_settings'] }) },
    onError: (e) => toast.error(e),
  })

  const lines = (preview.data ?? '').replace(/\[\/?B\]/g, '')

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Отчёт в Битрикс24 каждый день в 19:00">
        <QueryState query={cfg}>
            <div className="space-y-3 text-sm">
              <Checkbox label="Отправлять ежедневно в 19:00 (по Астане)" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <Field label="ID получателя в Битрикс24" hint="Откройте профиль получателя в Битрикс24 — число в адресе: …/company/personal/user/15/ → 15">
                {(id) => <Input id={id} value={recipient} onChange={(e) => setRecipient(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Например, 15" />}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button>
                <Button icon={<Send className="size-4" />} loading={send.isPending} disabled={!cfg.data?.recipient_id} onClick={() => send.mutate()}>Отправить сейчас</Button>
              </div>
              {cfg.data?.last_run_at && (
                <p className="text-slate-500">Последний запуск: {fmtDateTime(cfg.data.last_run_at)} — {cfg.data.last_result}</p>
              )}
              <details className="rounded-md border border-slate-200 p-3">
                <summary className="cursor-pointer font-medium">Как подключить (один раз)</summary>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-slate-600">
                  <li>Войдите в Битрикс24 <b>под тем пользователем, от чьего имени</b> будет приходить отчёт. Разработчикам → Другое → Входящий вебхук. Права: <b>«Чат и уведомления (im)»</b>. Сохраните и скопируйте адрес вебхука. Никому его не пересылайте — это ключ доступа.</li>
                  <li>Supabase → Edge Functions → Secrets → добавьте секрет <code>BITRIX_REPORT_WEBHOOK</code> = адрес вебхука.</li>
                  <li>Supabase → Edge Functions → создайте функцию <code>daily-report</code>, вставьте код из файла <code>supabase/functions/daily-report/index.ts</code>, Deploy. В её настройках выключите «Verify JWT».</li>
                  <li>Supabase → Database → Extensions: включены <code>pg_cron</code> и <code>pg_net</code>.</li>
                  <li>Здесь: ID получателя → «Сохранить» с галочкой → «Отправить сейчас» для проверки.</li>
                </ol>
              </details>
            </div>
        </QueryState>
      </Card>
      <Card title="Как будет выглядеть" actions={<Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Дата отчёта" />}>
        <QueryState query={preview}>
          {preview.data
            ? <pre className="whitespace-pre-wrap font-sans text-sm text-slate-800">{lines}</pre>
            : <p className="text-sm text-slate-500">За этот день работы нет — отчёт не отправится.</p>}
        </QueryState>
      </Card>
    </div>
  )
}
