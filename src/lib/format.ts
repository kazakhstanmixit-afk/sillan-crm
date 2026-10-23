const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 })

/** Дата из строки 'YYYY-MM-DD' без сдвига часового пояса */
export function parseDateOnly(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  return dateFmt.format(s.length === 10 ? parseDateOnly(s) : new Date(s))
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  return dateTimeFmt.format(new Date(s))
}

export function fmtMoney(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  return `${moneyFmt.format(Number(v))} ₸`
}

export function fmtNumber(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '0'
  return moneyFmt.format(Number(v))
}

/** Сегодняшняя дата 'YYYY-MM-DD' в локальном времени */
export function todayISO(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return toISODate(d)
}

export function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function startOfMonthISO(): string {
  const d = new Date()
  return toISODate(new Date(d.getFullYear(), d.getMonth(), 1))
}

export function isOverdue(date: string | null | undefined): boolean {
  return Boolean(date && date < todayISO())
}

/**
 * Ссылка «Карта» — Google Карты: по координатам (точная точка), иначе поиск по городу и адресу.
 * На телефоне открывается приложение Google Maps.
 */
export function mapHref(opts: { lat?: number | null; lng?: number | null; address?: string | null; city?: string | null }): string | null {
  if (opts.lat != null && opts.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${opts.lat},${opts.lng}`
  }
  const q = [opts.city, opts.address].filter(Boolean).join(', ')
  if (!q) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
