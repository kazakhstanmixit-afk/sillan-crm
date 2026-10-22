import { splitPhones } from '@/lib/phone'
import type { Direction } from '@/lib/types'
import { normText } from './normalize'

export type CrmField =
  | 'name' | 'company_name' | 'legal_name' | 'bin' | 'category' | 'city' | 'district' | 'address' | 'phones'
  | 'website' | 'lat' | 'lng' | 'coords' | 'external_id' | 'source_url'

export const CRM_FIELDS: { key: CrmField; label: string; multi?: boolean; hint?: string }[] = [
  { key: 'name', label: 'Название (обязательно)' },
  { key: 'category', label: 'Категория / рубрика', hint: 'По ней подбираются направления' },
  { key: 'city', label: 'Город' },
  { key: 'district', label: 'Район' },
  { key: 'address', label: 'Адрес' },
  { key: 'phones', label: 'Телефон', multi: true, hint: 'Можно выбрать несколько столбцов' },
  { key: 'website', label: 'Сайт' },
  { key: 'lat', label: 'Широта' },
  { key: 'lng', label: 'Долгота' },
  { key: 'coords', label: 'Координаты одной строкой', hint: '«43.23, 76.94»' },
  { key: 'external_id', label: 'Внешний ID записи', hint: 'Главный признак для защиты от дублей' },
  { key: 'source_url', label: 'Ссылка на источник' },
  { key: 'company_name', label: 'Компания / сеть' },
  { key: 'legal_name', label: 'Юридическое лицо' },
  { key: 'bin', label: 'БИН' },
]

const SYNONYMS: Record<CrmField, string[]> = {
  name: ['название', 'наименование', 'name', 'организация', 'название организации', 'title', 'филиал'],
  category: ['рубрика', 'рубрики', 'категория', 'категории', 'category', 'вид деятельности', 'деятельность'],
  city: ['город', 'city', 'населенный пункт', 'нас пункт'],
  district: ['район', 'district', 'район города'],
  address: ['адрес', 'address', 'улица', 'полный адрес'],
  phones: ['телефон', 'телефоны', 'phone', 'phones', 'тел', 'мобильный', 'контактный телефон'],
  website: ['сайт', 'website', 'web', 'веб сайт', 'url сайта'],
  lat: ['широта', 'lat', 'latitude'],
  lng: ['долгота', 'lng', 'lon', 'longitude'],
  coords: ['координаты', 'coordinates', 'геокоординаты'],
  external_id: ['id', '2gis id', 'id 2gis', 'firm id', 'внешний id', 'id организации', 'id филиала', 'branch id'],
  source_url: ['ссылка', 'url', 'link', 'ссылка на 2гис', 'ссылка на 2gis', 'ссылка на карточку'],
  company_name: ['компания', 'бренд', 'сеть', 'группа компаний'],
  legal_name: ['юр лицо', 'юридическое лицо', 'юр название', 'юридическое название'],
  bin: ['бин', 'иин бин', 'bin'],
}

/** Автоматическое сопоставление столбцов файла с полями CRM по названиям */
export function autoMap(headers: string[]): Record<string, CrmField | ''> {
  const used = new Set<CrmField>()
  const out: Record<string, CrmField | ''> = {}
  for (const h of headers) {
    const n = normText(h) ?? ''
    let found: CrmField | '' = ''
    for (const [field, syn] of Object.entries(SYNONYMS) as [CrmField, string[]][]) {
      if (used.has(field) && field !== 'phones') continue
      if (syn.some((s) => n === s)) { found = field; break }
    }
    if (!found) {
      for (const [field, syn] of Object.entries(SYNONYMS) as [CrmField, string[]][]) {
        if (used.has(field) && field !== 'phones') continue
        if (syn.some((s) => s.length > 3 && n.includes(s))) { found = field; break }
      }
    }
    if (found) used.add(found)
    out[h] = found
  }
  return out
}

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
  const phones = get('phones').flatMap(splitPhones)
  const category = one('category')

  return {
    data: {
      name, company_name: one('company_name'), legal_name: one('legal_name'), bin: bin.length === 12 ? bin : '', category,
      city: one('city'), district: one('district'), address: one('address'), phones: [...new Set(phones)], website: one('website'),
      lat, lng, external_id: one('external_id'), source_url: one('source_url'),
      direction_ids: matchDirections(`${category} ${name}`, directions),
    },
    errors,
    warnings,
  }
}
