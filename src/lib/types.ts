export type Role = 'admin' | 'head' | 'rep'

export interface Profile {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  role: Role
  is_active: boolean
  can_view_all: boolean
  can_import: boolean
  created_at: string
}

export interface Permissions {
  role: Role | null
  active: boolean
  view_all: boolean
  edit_all: boolean
  assign: boolean
  view_team: boolean
  archive: boolean
  import: boolean
  manage_users: boolean
  manage_dictionaries: boolean
}

export interface Direction { id: string; name: string; keywords: string[]; sort: number; is_active: boolean }
export interface Service { id: string; name: string; direction_id: string | null; sort: number; is_active: boolean }
export interface EquipmentCategory { id: string; name: string; sort: number; is_active: boolean }
export interface EquipmentBrand { id: string; name: string; is_active: boolean }
export interface ClientStatus { code: string; name: string; sort: number; color: string; is_active: boolean }
export interface RequestStatus { code: string; name: string; sort: number; is_final: boolean; color: string; is_active: boolean }
export interface DealStage { code: string; name: string; sort: number; kind: 'open' | 'won' | 'lost'; is_active: boolean }

export interface Company {
  id: string
  name: string
  legal_name: string | null
  bin: string | null
  client_type: string | null
  website: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Location {
  id: string
  company_id: string | null
  name: string
  client_type: string | null
  status_code: string
  country: string
  city: string | null
  district: string | null
  source_address: string | null
  confirmed_address: string | null
  address_note: string | null
  lat: number | null
  lng: number | null
  phones: string[]
  website: string | null
  posts_count: number | null
  lifts_count: number | null
  infrastructure_note: string | null
  capacity_note: string | null
  source: string
  source_url: string | null
  external_id: string | null
  source_category: string | null
  last_import_at: string | null
  manager_id: string | null
  last_visit_at: string | null
  next_visit_date: string | null
  next_contact_date: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface LocationListRow {
  id: string
  name: string
  company_id: string | null
  company_name: string | null
  legal_name: string | null
  client_type: string | null
  status_code: string
  city: string | null
  district: string | null
  address: string | null
  address_confirmed: boolean
  lat: number | null
  lng: number | null
  phones: string[]
  source: string
  manager_id: string | null
  manager_name: string | null
  last_visit_at: string | null
  next_visit_date: string | null
  next_contact_date: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
  direction_ids: string[]
  contact_name: string | null
  contact_phone: string | null
}

export interface Contact {
  id: string
  location_id: string
  full_name: string | null
  position: string | null
  phone: string | null
  whatsapp: string | null
  email: string | null
  decision_role: string | null
  preferred_channel: string | null
  comment: string | null
  is_actual: boolean
  is_primary: boolean
  created_at: string
  archived_at: string | null
}

export interface Equipment {
  id: string
  location_id: string
  category_id: string | null
  brand_id: string | null
  name: string
  model: string | null
  quantity: number
  condition: string
  need: string
  comment: string | null
  created_at: string
  archived_at: string | null
}

export interface Photo {
  id: string
  location_id: string
  visit_id: string | null
  storage_path: string
  caption: string | null
  comment: string | null
  uploaded_by: string | null
  created_at: string
}

export interface Comment {
  id: string
  location_id: string
  kind: string
  body: string
  next_contact_date: string | null
  author_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export type VisitStatus = 'planned' | 'done' | 'rescheduled' | 'cancelled' | 'failed'

export interface Visit {
  id: string
  plan_id: string | null
  location_id: string
  manager_id: string
  planned_date: string
  position: number
  purpose: string | null
  prep_notes: string | null
  status: VisitStatus
  actual_at: string | null
  result: string | null
  talked_to: string | null
  contact_id: string | null
  services_note: string | null
  equipment_note: string | null
  needs: string | null
  interest: string | null
  agreements: string | null
  objections: string | null
  next_step: string | null
  follow_up_required: boolean
  next_contact_date: string | null
  comment: string | null
  status_reason: string | null
  rescheduled_to: string | null
  created_at: string
}

export interface Request {
  id: string
  number: string
  kind: 'equipment' | 'parts'
  location_id: string
  contact_id: string | null
  visit_id: string | null
  initiator_id: string
  assignee_id: string | null
  assignee_name: string | null
  status_code: string
  urgency: string
  category_id: string | null
  item_name: string
  brand: string | null
  model: string | null
  article: string | null
  quantity: number
  budget: number | null
  description: string | null
  comment: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface Deal {
  id: string
  location_id: string
  manager_id: string
  title: string
  product: string | null
  amount: number | null
  stage_code: string
  probability: number | null
  expected_close_date: string | null
  source: string | null
  visit_id: string | null
  request_id: string | null
  next_step: string | null
  next_action_date: string | null
  lost_reason: string | null
  comment: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
}

export interface Notification {
  id: string
  kind: string
  title: string
  body: string | null
  link: string | null
  is_read: boolean
  created_at: string
}

export interface ImportJob {
  id: string
  file_name: string
  sheet_name: string | null
  source: string
  mode: string
  update_fields: string[]
  status: string
  total_rows: number
  created_count: number
  updated_count: number
  skipped_count: number
  conflict_count: number
  error_count: number
  created_by: string | null
  created_at: string
  finished_at: string | null
}
