// Те же правила нормализации, что в базе (app.norm_text / app.norm_address),
// чтобы находить дубликаты внутри одного файла до отправки в базу.

export function normText(s: string | null | undefined): string | null {
  const t = (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return t || null
}

const ADDRESS_WORDS = new Set(['ул', 'улица', 'пр', 'просп', 'проспект', 'прт', 'мкр', 'микрорайон', 'д', 'дом', 'г', 'город', 'кв', 'офис', 'оф', 'здание', 'зд', 'строение', 'стр', 'к', 'корпус', 'район'])

export function normAddress(s: string | null | undefined): string | null {
  const t = normText(s)
  if (!t) return null
  const words = t.split(' ')
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    // «пр т» и «р н» — два слова после нормализации «пр-т», «р-н»
    if ((words[i] === 'пр' && words[i + 1] === 'т') || (words[i] === 'р' && words[i + 1] === 'н')) { i++; continue }
    if (ADDRESS_WORDS.has(words[i])) continue
    out.push(words[i])
  }
  return out.join(' ') || null
}

/** Ключ строки для поиска повторов внутри файла */
export function rowKey(d: { external_id?: string | null; name?: string | null; city?: string | null; address?: string | null }): string | null {
  if (d.external_id) return 'ext:' + d.external_id.trim()
  const a = normAddress(d.address)
  if (!a) return null
  return ['addr', normText(d.name), normText(d.city), a].join('|')
}
