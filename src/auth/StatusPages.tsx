import { useAuth } from './AuthProvider'
import { Button } from '@/components/ui'

export function NotConfiguredPage() {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-lg space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-semibold">Не настроено подключение к базе данных</h1>
        <p>Задайте переменные окружения <code>VITE_SUPABASE_URL</code> и <code>VITE_SUPABASE_ANON_KEY</code> (см. файл <code>.env.example</code> и README) и пересоберите приложение.</p>
      </div>
    </div>
  )
}

export function InactivePage() {
  const { profile, signOut } = useAuth()
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="max-w-md space-y-3 rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-700">
        <h1 className="text-lg font-semibold text-slate-900">Доступ ещё не открыт</h1>
        <p>Учётная запись <b>{profile?.email}</b> создана, но не активирована. Попросите администратора CRM открыть доступ и назначить роль.</p>
        <Button onClick={signOut}>Выйти</Button>
      </div>
    </div>
  )
}
