import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Подключение к Supabase настроено (переменные окружения заданы при сборке). */
export const isConfigured = Boolean(url && key)

export const supabase: SupabaseClient = isConfigured
  ? createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true } })
  : (new Proxy({}, {
      get() {
        throw new Error('Supabase не настроен: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY')
      },
    }) as SupabaseClient)

export const FILES_BUCKET = 'crm-files'
