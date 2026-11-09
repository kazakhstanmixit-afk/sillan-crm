// Edge Functions (Deno) импортируют supabase-js как «npm:…»; для проверки типов и тестов — тот же пакет.
declare module 'npm:@supabase/supabase-js@2' {
  export * from '@supabase/supabase-js'
}
