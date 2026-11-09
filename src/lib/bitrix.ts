import { supabase } from './supabase'

export interface BitrixSyncResult {
  disabled?: boolean
  sent?: number
  errors?: string[]
  warnings?: string[]
  left?: number | null
  deals?: { id: string; bitrix_deal_id: string | null }[]
  error?: string
}

/** Вызов функции bitrix; ошибки — текстом, без исключений (заявка уже сохранена в CRM). */
export async function callBitrix(body: Record<string, unknown>): Promise<BitrixSyncResult & Record<string, any>> {
  const { data, error } = await supabase.functions.invoke('bitrix', { body })
  if (error) {
    const ctx = (error as { context?: Response }).context
    let msg = ''
    try {
      const j = await ctx?.json()
      if (j?.disabled) return { disabled: true, error: j.error }
      msg = j?.error ?? j?.message ?? ''
    } catch { /* не JSON */ }
    if (!msg && (ctx?.status === 404 || /Failed to send|not found/i.test(error.message))) {
      return { error: 'Функция bitrix не найдена в Supabase или у неё включена проверка JWT («Verify JWT»)' }
    }
    if (ctx?.status === 401 && /jwt/i.test(msg)) msg = 'У функции bitrix включена проверка JWT — выключите «Verify JWT» в её настройках'
    return { error: msg || error.message }
  }
  return data
}

/** Отправить в Битрикс24 сделки по новым заявкам — в фоне, молча (не ушло — дошлёт расписание). */
export function syncRequestsToBitrix(requestIds: string[]) {
  if (!requestIds.length) return
  void callBitrix({ action: 'sync', request_ids: requestIds }).catch(() => undefined)
}
