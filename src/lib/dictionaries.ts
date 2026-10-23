import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import { unwrap } from './errors'
import type {
  ClientStatus, DealStage, Direction, EquipmentBrand, EquipmentCategory, Profile, RequestStatus, Service,
} from './types'

export interface Dictionaries {
  directions: Direction[]
  services: Service[]
  categories: EquipmentCategory[]
  brands: EquipmentBrand[]
  clientStatuses: ClientStatus[]
  requestStatuses: RequestStatus[]
  dealStages: DealStage[]
  profiles: Profile[]
  holidays: { id: string; day: string; name: string; is_active: boolean }[]
}

export async function loadDictionaries(): Promise<Dictionaries> {
  const [directions, services, categories, brands, clientStatuses, requestStatuses, dealStages, profiles, holidays] = await Promise.all([
    supabase.from('directions').select('*').order('sort').order('name'),
    supabase.from('services').select('*').order('sort').order('name'),
    supabase.from('equipment_categories').select('*').order('sort').order('name'),
    supabase.from('equipment_brands').select('*').order('name'),
    supabase.from('client_statuses').select('*').order('sort'),
    supabase.from('request_statuses').select('*').order('sort'),
    supabase.from('deal_stages').select('*').order('sort'),
    supabase.from('profiles').select('id, full_name, email, phone, role, is_active, can_view_all, can_import, created_at').order('full_name'),
    supabase.from('holidays').select('id, day, name, is_active').order('day'),
  ])
  return {
    directions: unwrap(directions),
    services: unwrap(services),
    categories: unwrap(categories),
    brands: unwrap(brands),
    clientStatuses: unwrap(clientStatuses),
    requestStatuses: unwrap(requestStatuses),
    dealStages: unwrap(dealStages),
    profiles: unwrap(profiles) as Profile[],
    // справочник праздников появляется с обновлением базы «автоплан»; до этого — пусто
    holidays: holidays.error ? [] : (holidays.data ?? []),
  }
}

const EMPTY: Dictionaries = {
  directions: [], services: [], categories: [], brands: [], clientStatuses: [], requestStatuses: [], dealStages: [], profiles: [], holidays: [],
}

/** Справочники и список сотрудников (кэшируются; сбрасываются после изменений в «Настройках»). */
export function useDicts() {
  const q = useQuery({ queryKey: ['dicts'], queryFn: loadDictionaries, staleTime: 5 * 60_000 })
  const d = q.data ?? EMPTY
  return {
    ...d,
    isLoading: q.isLoading,
    error: q.error,
    activeDirections: d.directions.filter((x) => x.is_active),
    activeServices: d.services.filter((x) => x.is_active),
    activeCategories: d.categories.filter((x) => x.is_active),
    activeBrands: d.brands.filter((x) => x.is_active),
    managers: d.profiles.filter((p) => p.is_active),
    directionName: (id: string) => d.directions.find((x) => x.id === id)?.name ?? '—',
    profileName: (id: string | null | undefined) => (id ? d.profiles.find((p) => p.id === id)?.full_name || 'Без имени' : '—'),
    clientStatus: (code: string) => d.clientStatuses.find((s) => s.code === code),
    requestStatus: (code: string) => d.requestStatuses.find((s) => s.code === code),
    dealStage: (code: string) => d.dealStages.find((s) => s.code === code),
    categoryName: (id: string | null) => (id ? d.categories.find((c) => c.id === id)?.name ?? '—' : '—'),
    brandName: (id: string | null) => (id ? d.brands.find((c) => c.id === id)?.name ?? '—' : '—'),
  }
}
