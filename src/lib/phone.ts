/** Нормализация телефона — те же правила, что в базе (app.norm_phone). */
export function normPhone(p: string | null | undefined): string | null {
  const d = (p ?? '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 11 && d[0] === '8') return '7' + d.slice(1)
  if (d.length === 10) return '7' + d
  return d
}

/** +7 701 123 45 67 */
export function formatPhone(p: string | null | undefined): string {
  if (!p) return ''
  const n = normPhone(p)
  if (n && n.length === 11 && n[0] === '7') {
    return `+7 ${n.slice(1, 4)} ${n.slice(4, 7)} ${n.slice(7, 9)} ${n.slice(9)}`
  }
  return p
}

/** Разбить строку с несколькими телефонами (как в выгрузках 2GIS). */
export function splitPhones(raw: string | null | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/\D/g, '').length >= 6)
}

/** Ссылки для звонка и WhatsApp */
export const telHref = (p: string) => `tel:+${normPhone(p) ?? ''}`
export const waHref = (p: string) => `https://wa.me/${normPhone(p) ?? ''}`

/**
 * Поисковая подстрока для search_text: если пользователь вводит телефон в любом формате,
 * ищем по цифрам в нормализованном виде.
 */
export function searchPattern(q: string): string {
  const t = q.trim().toLowerCase()
  if (/^[\d\s()+\-]+$/.test(t)) {
    const digits = t.replace(/\D/g, '')
    if (digits.length >= 10) return normPhone(digits) ?? digits
    return digits
  }
  return t
}
