import { supabase } from './supabase'

export interface BitrixSendResult { disabled?: boolean; entity?: 'lead' | 'deal'; results?: { id: string; number: string; ok: boolean; bitrix_id?: string; error?: string }[]; error?: string }

export const BITRIX_ENTITY_LABEL: Record<string, string> = { lead: 'лид', deal: 'сделка' }

/**
 * Отправить заявки в Битрикс24 (функция bitrix в Supabase). Если интеграция не настроена
 * или функция не развёрнута — возвращает { disabled: true } без ошибки: заявка остаётся в CRM.
 */
export async function sendToBitrix(body: { request_ids: string[] } | { action: 'send_pending' }): Promise<BitrixSendResult> {
  const { data, error } = await supabase.functions.invoke('bitrix', { body: 'action' in body ? body : { action: 'send', ...body } })
  if (error) {
    let msg = ''
    try {
      const j = await (error as { context?: Response }).context?.json()
      if (j?.disabled) return { disabled: true }
      msg = j?.error ?? ''
    } catch {
      msg = ''
    }
    if (!msg && /Failed to send|not found|404/i.test(error.message)) return { disabled: true }
    return { error: msg || error.message }
  }
  return data as BitrixSendResult
}

/** Текст для уведомления после отправки */
export function bitrixToast(r: BitrixSendResult): { ok?: string; error?: string } | null {
  if (r.disabled) return null
  if (r.error) return { error: `Битрикс24: ${r.error}. Заявка сохранена в CRM — её можно отправить повторно.` }
  const sent = (r.results ?? []).filter((x) => x.ok && x.bitrix_id)
  const failed = (r.results ?? []).filter((x) => !x.ok)
  if (failed.length) return { error: `Битрикс24: не отправлено ${failed.map((f) => f.number).join(', ')} — ${failed[0].error}` }
  if (sent.length) return { ok: `Отправлено в Битрикс24: ${sent.map((s) => `${s.number} → ${BITRIX_ENTITY_LABEL[r.entity ?? 'lead']} №${s.bitrix_id}`).join(', ')}` }
  return null
}
