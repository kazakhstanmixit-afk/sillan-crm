import { normPhone, splitPhones } from '@/lib/phone'
import type { Direction } from '@/lib/types'
import { normText } from './normalize'

export type CrmField =
  | 'name' | 'company_name' | 'legal_name' | 'bin' | 'category' | 'city' | 'district' | 'address' | 'phones'
  | 'website' | 'lat' | 'lng' | 'coords' | 'external_id' | 'source_url'

export const CRM_FIELDS: { key: CrmField; label: string; multi?: boolean; hint?: string }[] = [
  { key: 'name', label: 'Название (обязательно)' },
  { key: 'category', label: 'Категория / рубрика 2GIS', multi: true, hint: 'Хранится как есть; несколько столбцов объединяются' },
  { key: 'city', label: 'Город' },
  { key: 'district', label: 'Район' },
  { key: 'address', label: 'Адрес' },
  { key: 'phones', label: 'Телефон', multi: true, hint: 'Можно выбрать несколько столбцов' },
  { key: 'website', label: 'Сайт', multi: true, hint: 'Из нескольких столбцов берётся первый заполненный' },
  { key: 'lat', label: 'Широта' },
  { key: 'lng', label: 'Долгота' },
  { key: 'coords', label: 'Координаты одной строкой', hint: '«43.23, 76.94»' },
  { key: 'external_id', label: 'Внешний ID записи', hint: 'Главный признак для защиты от дублей' },
  { key: 'source_url', label: 'Ссылка на источник' },
  { key: 'company_name', label: 'Компания / сеть' },
  { key: 'legal_name', label: 'Юридическое лицо' },
  { key: 'bin', label: 'БИН' },
]

/** Заголовок столбца → слова: «phoneValue/0» → «phone value 0», «location/lat» → «location lat» */
export function normHeader(h: string): string {
  return normText(h.replace(/([a-zа-я])([A-ZА-Я])/g, '$1 $2')) ?? ''
}
/** Заголовок без порядковых номеров: «rubrics/0/name» → «rubrics name» */
const baseOf = (n: string) => n.split(' ').filter((t) => !/^\d+$/.test(t)).join(' ')

interface Rule { field: CrmField; exact: string[]; suggest?: string[] }

// Порядок важен: при совпадении берётся первое правило.
// exact — назначается автоматически; suggest — только предлагается, пользователь подтверждает.
const RULES: Rule[] = [
  { field: 'name', exact: ['name', 'title', 'название', 'наименование', 'название организации', 'организация'], suggest: ['short name', 'brand short name', 'филиал', 'краткое название'] },
  { field: 'category', exact: ['category', 'categories', 'categories name', 'rubric', 'rubrics', 'rubrics name', 'рубрика', 'рубрики', 'категория', 'категории', 'вид деятельности'] },
  { field: 'city', exact: ['city', 'город', 'населенный пункт', 'нас пункт', 'address city'] },
  { field: 'district', exact: ['district', 'район', 'район города', 'address district'] },
  { field: 'address', exact: ['address', 'адрес', 'full address', 'address name', 'полный адрес', 'address full'], suggest: ['street', 'улица'] },
  { field: 'phones', exact: ['phone', 'phones', 'phone value', 'phone number', 'phone text', 'phones value', 'phones text', 'телефон', 'телефоны', 'контактный телефон', 'мобильный'] },
  { field: 'website', exact: ['website', 'websites', 'site', 'сайт', 'веб сайт', 'url сайта'] },
  { field: 'source_url', exact: ['url', 'link', 'source url', 'ссылка', 'ссылка на 2гис', 'ссылка на 2gis', 'ссылка на карточку', '2gis url'] },
  { field: 'lat', exact: ['lat', 'latitude', 'location lat', 'point lat', 'coordinates lat', 'geo lat', 'широта'] },
  { field: 'lng', exact: ['lng', 'lon', 'longitude', 'location lng', 'location lon', 'point lon', 'point lng', 'coordinates lng', 'geo lon', 'долгота'] },
  { field: 'coords', exact: ['coordinates', 'координаты', 'геокоординаты'] },
  { field: 'external_id', exact: ['id', 'external id', 'firm id', '2gis id', 'id 2gis', 'внешний id', 'id организации', 'id филиала', 'branch id'] },
  { field: 'company_name', exact: [], suggest: ['brand', 'brand name', 'бренд', 'сеть', 'компания', 'группа компаний'] },
  { field: 'legal_name', exact: ['legal name', 'юр лицо', 'юридическое лицо', 'юр название', 'юридическое название'] },
  { field: 'bin', exact: ['bin', 'бин', 'иин бин'] },
]

export interface MappingSuggestion {
  mapping: Record<string, CrmField | ''>
  /** столбцы, сопоставленные автоматически (очевидное совпадение) */
  auto: string[]
  /** предложения, которые нужно подтвердить: столбец → поле и причина */
  suggestions: Record<string, { field: CrmField; reason: string }>
}

const fieldLabel = (f: CrmField) => CRM_FIELDS.find((x) => x.key === f)?.label ?? f

/**
 * Сопоставление столбцов файла с полями CRM. Очевидные совпадения назначаются сразу
 * (title → Название, phoneValue → Телефон, url → Ссылка на источник, location/lat → Широта),
 * неоднозначные — только предлагаются.
 */
export function suggestMapping(headers: string[]): MappingSuggestion {
  const mapping: Record<string, CrmField | ''> = {}
  const auto: string[] = []
  const suggestions: MappingSuggestion['suggestions'] = {}
  const owner = new Map<CrmField, string>()
  for (const h of headers) {
    mapping[h] = ''
    const n = normHeader(h)
    const base = baseOf(n)
    const rule = RULES.find((r) => r.exact.includes(n) || r.exact.includes(base))
    if (rule) {
      const multi = CRM_FIELDS.find((f) => f.key === rule.field)?.multi
      const taken = owner.get(rule.field)
      if (!multi && taken) {
        suggestions[h] = { field: rule.field, reason: `Похоже на «${fieldLabel(rule.field)}», но это поле уже взято из столбца «${taken}»` }
      } else {
        mapping[h] = rule.field
        auto.push(h)
        owner.set(rule.field, h)
      }
      continue
    }
    // предлагаем только по точному совпадению со списком подсказок — без поиска по части слова,
    // иначе brand/rating, brand/branchCount и подобные служебные столбцы засоряют экран
    const sug = RULES.find((r) => r.suggest?.includes(n) || r.suggest?.includes(base))
    if (sug) {
      const taken = !CRM_FIELDS.find((f) => f.key === sug.field)?.multi && owner.get(sug.field)
      suggestions[h] = {
        field: sug.field,
        reason: taken ? `Похоже на «${fieldLabel(sug.field)}», но это поле уже взято из столбца «${taken}»` : `Возможно, «${fieldLabel(sug.field)}» — подтвердите`,
      }
    }
  }
  // В выгрузке Apify столбец category — служебный код (service_station), а названия рубрик — в rubrics/N.
  // Если рубрики есть, код не загружаем, только предлагаем.
  const rubricCols = headers.filter((h) => ['rubric', 'rubrics', 'rubrics name', 'рубрика', 'рубрики'].includes(baseOf(normHeader(h))))
  if (rubricCols.length) {
    for (const h of headers) {
      if (mapping[h] === 'category' && !rubricCols.includes(h)) {
        mapping[h] = ''
        auto.splice(auto.indexOf(h), 1)
        suggestions[h] = { field: 'category', reason: 'В файле есть рубрики 2GIS (rubrics) — этот столбец обычно служебный код, загружать не нужно' }
      }
    }
  }
  return { mapping, auto, suggestions }
}

/** Только автоматические сопоставления (без неподтверждённых предложений) */
export function autoMap(headers: string[]): Record<string, CrmField | ''> {
  return suggestMapping(headers).mapping
}

/** Заголовки CSV-шаблона Sillan CRM */
export const TEMPLATE_HEADERS = ['name', 'category', 'city', 'district', 'address', 'phone', 'website', 'latitude', 'longitude', 'external_id', 'source_url']

export interface RowData {
  name: string
  company_name: string
  legal_name: string
  bin: string
  category: string
  city: string
  district: string
  address: string
  phones: string[]
  website: string
  lat: number | null
  lng: number | null
  external_id: string
  source_url: string
  direction_ids: string[]
}

export interface BuiltRow { data: RowData; errors: string[]; warnings: string[] }

const num = (s: string) => {
  const v = Number(s.replace(',', '.').trim())
  return s.trim() === '' || Number.isNaN(v) ? null : v
}

/**
 * Подобрать направления по категории и названию (ключевые слова из справочника).
 * Длинное ключевое слово совпадает с началом слова («вулканизац» → «вулканизация»),
 * короткое (до 3 букв, например «сто») — только целым словом, чтобы не ловить «стоматология».
 */
export function matchDirections(text: string, directions: Direction[]): string[] {
  const t = ' ' + (normText(text) ?? '') + ' '
  return directions.filter((d) => d.is_active && d.keywords.some((k) => {
    const kw = normText(k)
    if (!kw) return false
    return kw.length <= 3 ? t.includes(' ' + kw + ' ') : t.includes(' ' + kw)
  })).map((d) => d.id)
}

export function buildRow(raw: Record<string, string>, mapping: Record<string, CrmField | ''>, directions: Direction[]): BuiltRow {
  const get = (f: CrmField) => Object.entries(mapping).filter(([, v]) => v === f).map(([h]) => raw[h] ?? '').filter((x) => x.trim() !== '')
  const one = (f: CrmField) => get(f)[0]?.trim() ?? ''
  const errors: string[] = []
  const warnings: string[] = []

  let lat = num(one('lat'))
  let lng = num(one('lng'))
  const coords = one('coords')
  if (coords && (lat === null || lng === null)) {
    const m = coords.match(/(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)/)
    if (m) { lat = num(m[1]); lng = num(m[2]) }
  }
  if ((lat !== null && (lat < -90 || lat > 90)) || (lng !== null && (lng < -180 || lng > 180))) {
    warnings.push('Координаты вне допустимого диапазона — не будут сохранены')
    lat = null
    lng = null
  }
  if ((lat === null) !== (lng === null)) { lat = null; lng = null }

  const name = one('name')
  if (!name) errors.push('Не заполнено название')
  else if (name.length > 200) errors.push('Название длиннее 200 символов')

  const bin = one('bin').replace(/\D/g, '')
  if (bin && bin.length !== 12) warnings.push('БИН не из 12 цифр — не будет сохранён')
  // телефоны из нескольких столбцов; одинаковые номера в разной записи считаются одним
  const phones: string[] = []
  const seenPhones = new Set<string>()
  for (const p of get('phones').flatMap(splitPhones)) {
    const k = normPhone(p) ?? p
    if (!seenPhones.has(k)) { seenPhones.add(k); phones.push(p); continue }
    // из двух записей одного номера («+7‒708‒909‒95‒23» и «+77089099523») оставляем чистую
    const i = phones.findIndex((x) => (normPhone(x) ?? x) === k)
    if (/^\+?\d+$/.test(p) && !/^\+?\d+$/.test(phones[i])) phones[i] = p
  }
  // категорий может быть несколько (rubrics/0, rubrics/1…) — объединяем без повторов
  const categoryParts: string[] = []
  for (const c of get('category').flatMap((x) => x.split(/\s*[,;]\s*/))) {
    if (c && !categoryParts.some((x) => x.toLowerCase() === c.toLowerCase())) categoryParts.push(c)
  }
  const category = categoryParts.join(', ')

  return {
    data: {
      name, company_name: one('company_name'), legal_name: one('legal_name'), bin: bin.length === 12 ? bin : '', category,
      city: one('city'), district: one('district'), address: one('address'), phones, website: one('website'),
      lat, lng, external_id: one('external_id'), source_url: one('source_url'),
      direction_ids: matchDirections(`${category} ${name}`, directions),
    },
    errors,
    warnings,
  }
}
