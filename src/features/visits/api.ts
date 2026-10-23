import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import type { Visit } from '@/lib/types'

export interface PlanLocation {
  id: string
  name: string
  city: string | null
  district: string | null
  source_address: string | null
  confirmed_address: string | null
  lat: number | null
  lng: number | null
  phones: string[]
  status_code: string
  manager_id: string | null
  external_id: string | null
}
export type PlanVisit = Visit & { location: PlanLocation | null }

export interface PlanData {
  plan: { id: string; manager_id: string; plan_date: string; notes: string | null } | null
  visits: PlanVisit[]
  contacts: Record<string, { full_name: string | null; phone: string | null }>
}

const LOC_FIELDS = 'id,name,city,district,source_address,confirmed_address,lat,lng,phones,status_code,manager_id,external_id'

export async function fetchPlan(managerId: string, date: string): Promise<PlanData> {
  const plan = unwrap(await supabase.from('visit_plans').select('id,manager_id,plan_date,notes').eq('manager_id', managerId).eq('plan_date', date).maybeSingle()) as PlanData['plan']
  if (!plan) return { plan: null, visits: [], contacts: {} }
  const visits = unwrap(await supabase.from('visits').select(`*, location:locations(${LOC_FIELDS})`).eq('plan_id', plan.id).order('position')) as PlanVisit[]
  const ids = [...new Set(visits.map((v) => v.location_id))]
  const contacts: PlanData['contacts'] = {}
  if (ids.length) {
    const rows = unwrap(await supabase.from('contacts').select('location_id,full_name,phone,is_primary').in('location_id', ids).is('archived_at', null).eq('is_actual', true)
      .order('is_primary', { ascending: false }).order('created_at')) as { location_id: string; full_name: string | null; phone: string | null }[]
    for (const r of rows) if (!contacts[r.location_id]) contacts[r.location_id] = { full_name: r.full_name, phone: r.phone }
  }
  return { plan, visits, contacts }
}

export async function addToPlan(managerId: string, date: string, locationIds: string[], purpose?: string) {
  const planId = unwrap(await supabase.rpc('ensure_visit_plan', { p_manager: managerId, p_date: date })) as string
  const added = unwrap(await supabase.rpc('add_plan_visits', { p_plan: planId, p_location_ids: locationIds, p_purpose: purpose || null })) as number
  return { planId, added }
}

export const VISIT_LIST_FIELDS = `*, location:locations(${LOC_FIELDS})`
