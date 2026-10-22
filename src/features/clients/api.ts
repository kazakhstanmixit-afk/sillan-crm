import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { searchPattern } from '@/lib/phone'
import type { Location, LocationListRow } from '@/lib/types'

export interface ClientFilters {
  q: string
  city: string
  district: string
  direction: string
  manager: string // '' | 'none' | uuid
  status: string
  company: string
  lastFrom: string
  lastTo: string
  nextFrom: string
  nextTo: string
  archived: boolean
  sort: string
  dir: 'asc' | 'desc'
  page: number
}

export const DEFAULT_FILTERS: ClientFilters = {
  q: '', city: '', district: '', direction: '', manager: '', status: '', company: '',
  lastFrom: '', lastTo: '', nextFrom: '', nextTo: '', archived: false, sort: 'updated_at', dir: 'desc', page: 1,
}

export const PAGE_SIZE = 50

export const SORTABLE = new Set(['name', 'company_name', 'city', 'district', 'address', 'status_code', 'manager_name', 'last_visit_at', 'next_visit_date', 'updated_at', 'created_at'])

export function filtersFromParams(p: URLSearchParams): ClientFilters {
  const f = { ...DEFAULT_FILTERS }
  for (const k of Object.keys(DEFAULT_FILTERS) as (keyof ClientFilters)[]) {
    const v = p.get(k)
    if (v === null) continue
    if (k === 'page') f.page = Math.max(1, Number(v) || 1)
    else if (k === 'archived') f.archived = v === '1'
    else if (k === 'dir') f.dir = v === 'asc' ? 'asc' : 'desc'
    else (f as Record<string, unknown>)[k] = v
  }
  if (!SORTABLE.has(f.sort)) f.sort = 'updated_at'
  return f
}

export function filtersToParams(f: ClientFilters): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) {
    const def = (DEFAULT_FILTERS as unknown as Record<string, unknown>)[k]
    if (v === def || v === '' || v === false) continue
    p.set(k, k === 'archived' ? '1' : String(v))
  }
  return p
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m)

const nextDay = (d: string) => {
  const x = new Date(d + 'T00:00:00')
  x.setDate(x.getDate() + 1)
  return x.toISOString().slice(0, 10)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyClientFilters(query: any, f: ClientFilters) {
  let q = query
  if (f.q.trim()) q = q.ilike('search_text', `%${escapeLike(searchPattern(f.q))}%`)
  if (f.city) q = q.eq('city', f.city)
  if (f.district) q = q.eq('district', f.district)
  if (f.direction) q = q.contains('direction_ids', [f.direction])
  if (f.manager === 'none') q = q.is('manager_id', null)
  else if (f.manager) q = q.eq('manager_id', f.manager)
  if (f.status) q = q.eq('status_code', f.status)
  if (f.company) q = q.eq('company_id', f.company)
  if (f.lastFrom) q = q.gte('last_visit_at', f.lastFrom)
  if (f.lastTo) q = q.lt('last_visit_at', nextDay(f.lastTo))
  if (f.nextFrom) q = q.gte('next_visit_date', f.nextFrom)
  if (f.nextTo) q = q.lte('next_visit_date', f.nextTo)
  q = f.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  return q
}

const LIST_COLUMNS =
  'id,name,company_id,company_name,legal_name,client_type,status_code,city,district,address,address_confirmed,lat,lng,phones,source,manager_id,manager_name,last_visit_at,next_visit_date,next_contact_date,created_at,updated_at,archived_at,direction_ids,contact_name,contact_phone'

export async function fetchClientPage(f: ClientFilters) {
  let q = supabase.from('location_list').select(LIST_COLUMNS, { count: 'exact' })
  q = applyClientFilters(q, f)
  q = q.order(f.sort, { ascending: f.dir === 'asc', nullsFirst: false }).order('id')
  const from = (f.page - 1) * PAGE_SIZE
  const res = await q.range(from, from + PAGE_SIZE - 1)
  if (res.error) throw res.error
  return { rows: (res.data ?? []) as unknown as LocationListRow[], total: res.count ?? 0 }
}

/** Все строки по фильтру (для экспорта и массовых операций), порциями по 1000. */
export async function fetchAllClients(f: ClientFilters, limit = 20000, onProgress?: (n: number) => void) {
  const rows: LocationListRow[] = []
  for (let from = 0; from < limit; from += 1000) {
    let q = supabase.from('location_list').select(LIST_COLUMNS)
    q = applyClientFilters(q, f).order(f.sort, { ascending: f.dir === 'asc', nullsFirst: false }).order('id')
    const part = unwrap(await q.range(from, Math.min(from + 999, limit - 1))) as unknown as LocationListRow[]
    rows.push(...part)
    onProgress?.(rows.length)
    if (part.length < 1000) break
  }
  return rows
}

export async function fetchFilterOptions(): Promise<{ cities: string[]; districts: { city: string; district: string }[] }> {
  return unwrap(await supabase.rpc('location_filter_options'))
}

export async function fetchLocation(id: string) {
  return unwrap(await supabase.from('locations').select('*').eq('id', id).maybeSingle()) as Location | null
}

export function clientKeys(id: string) {
  return {
    location: ['location', id] as const,
    contacts: ['location', id, 'contacts'] as const,
    directions: ['location', id, 'directions'] as const,
    services: ['location', id, 'services'] as const,
    equipment: ['location', id, 'equipment'] as const,
    photos: ['location', id, 'photos'] as const,
    comments: ['location', id, 'comments'] as const,
    visits: ['location', id, 'visits'] as const,
    requests: ['location', id, 'requests'] as const,
    deals: ['location', id, 'deals'] as const,
    history: ['location', id, 'history'] as const,
  }
}
