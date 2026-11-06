// Supabase Edge Function: ежедневный отчёт торговых в личку Битрикс24.
// Запускается расписанием (pg_cron, 19:00 по Астане) или кнопкой «Отправить сейчас» в CRM.
//
// Секреты (Supabase → Edge Functions → Secrets):
//   BITRIX_REPORT_WEBHOOK — адрес входящего вебхука Битрикс24 с правом «Чат и уведомления (im)»,
//                           созданного тем пользователем, от чьего имени уходит отчёт;
//   SERVICE_ROLE_KEY      — только если Supabase не передаёт SUPABASE_SERVICE_ROLE_KEY сам.
// В настройках функции выключите «Verify JWT»: функция сама проверяет, кто её вызвал.
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-report-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

/** Сегодня по Астане (UTC+5) в формате YYYY-MM-DD */
function todayAstana(now = new Date()): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('CRM_SECRET_KEY')
  if (!url || !service) {
    return json({ error: 'В функции нет секретного ключа. Supabase → Edge Functions → Secrets: добавьте SERVICE_ROLE_KEY (значение — Secret key из Settings → API Keys).' }, 500)
  }
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } })

  // кто вызывает: расписание (токен) или администратор/руководитель CRM (кнопка)
  let manual = false
  const token = req.headers.get('x-report-token')
  if (token) {
    const { data: ok } = await admin.rpc('daily_report_check_token', { p_token: token })
    if (!ok) return json({ error: 'Неверный токен расписания' }, 403)
  } else {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'Не выполнен вход' }, 401)
    const { data: u, error } = await admin.auth.getUser(jwt)
    if (error || !u.user) return json({ error: 'Сессия недействительна — войдите в CRM заново' }, 401)
    const { data: me } = await admin.from('profiles').select('role, is_active').eq('id', u.user.id).maybeSingle()
    if (!me?.is_active || !['admin', 'head'].includes(me.role)) return json({ error: 'Отправлять отчёт может руководитель или администратор' }, 403)
    manual = true
  }

  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* пустое тело */ }
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : todayAstana()

  const { data: setting } = await admin.from('app_settings').select('value').eq('key', 'daily_report').maybeSingle()
  const cfg = (setting?.value ?? {}) as Record<string, unknown>
  if (!manual && !cfg.enabled) return json({ skipped: 'Отправка выключена' })
  const recipient = String(cfg.recipient_id ?? '').trim()
  if (!/^\d+$/.test(recipient)) return json({ error: 'В настройках CRM не указан ID получателя в Битрикс24' }, 400)

  const webhook = (Deno.env.get('BITRIX_REPORT_WEBHOOK') ?? '').trim()
  if (!/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/?$/.test(webhook)) {
    return json({ error: 'Не задан секрет BITRIX_REPORT_WEBHOOK (адрес входящего вебхука Битрикс24 вида https://ваш.bitrix24.kz/rest/1/xxxx/)' }, 500)
  }

  const save = async (patch: Record<string, unknown>) => {
    await admin.from('app_settings').update({ value: { ...cfg, ...patch }, updated_at: new Date().toISOString() }).eq('key', 'daily_report')
  }

  const { data: text, error: textErr } = await admin.rpc('daily_report_preview', { p_date: date })
  if (textErr) return json({ error: 'Не удалось собрать отчёт: ' + textErr.message }, 500)
  if (!text) {
    await save({ last_run_at: new Date().toISOString(), last_result: `${date}: работы не было — не отправлено` })
    return json({ skipped: 'За день нет работы — отчёт не отправлен' })
  }

  try {
    const res = await fetch(webhook.replace(/\/?$/, '/') + 'im.message.add.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ DIALOG_ID: recipient, MESSAGE: text, URL_PREVIEW: 'N' }),
    })
    const out = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok || out.error) {
      const msg = String(out.error_description || out.error || `HTTP ${res.status}`)
      await save({ last_run_at: new Date().toISOString(), last_result: `${date}: ошибка Битрикс24 — ${msg}` })
      return json({ error: 'Битрикс24 не принял сообщение: ' + msg }, 502)
    }
    await save({ last_run_at: new Date().toISOString(), last_result: `${date}: отправлено` })
    return json({ sent: true, date })
  } catch (e) {
    await save({ last_run_at: new Date().toISOString(), last_result: `${date}: Битрикс24 недоступен` })
    return json({ error: 'Битрикс24 недоступен: ' + (e instanceof Error ? e.message : String(e)) }, 502)
  }
})
