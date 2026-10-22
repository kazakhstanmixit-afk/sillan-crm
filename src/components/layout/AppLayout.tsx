import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  BarChart3, Briefcase, CalendarCheck, ClipboardList, FileInput, History, LayoutDashboard, LogOut, Menu, Settings, Users, Building2, X,
} from 'lucide-react'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { ROLE_LABEL } from '@/lib/labels'
import { cn } from '@/components/ui'
import { displayLogin } from '@/lib/login'
import { GlobalSearch } from './GlobalSearch'
import { NotificationsBell } from './NotificationsBell'

interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; show?: boolean }

export function AppLayout() {
  const { profile, signOut } = useAuth()
  const perms = usePerms()
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const nav: NavItem[] = [
    { to: '/', label: 'Главная', icon: LayoutDashboard },
    { to: '/clients', label: 'Клиенты', icon: Building2 },
    { to: '/import', label: 'Импорт данных', icon: FileInput, show: perms.import || perms.view_team },
    { to: '/plan', label: 'План посещений', icon: CalendarCheck },
    { to: '/visits', label: 'История визитов', icon: History },
    { to: '/requests', label: 'Заявки', icon: ClipboardList },
    { to: '/deals', label: 'Потенциальные сделки', icon: Briefcase },
    { to: '/team', label: 'Сотрудники и распределение', icon: Users, show: perms.view_team },
    { to: '/analytics', label: 'Аналитика', icon: BarChart3 },
    { to: '/settings', label: 'Настройки и справочники', icon: Settings },
  ]

  const sidebar = (
    <nav className="flex h-full flex-col bg-brand-900 text-brand-100">
      <div className="flex h-14 items-center gap-2 px-4">
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="text-base font-semibold tracking-wide text-white">Sillan CRM</span>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {nav.filter((n) => n.show !== false).map((n) => (
          <li key={n.to}>
            <NavLink
              to={n.to}
              end={n.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn('flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] transition-colors',
                  isActive ? 'bg-white/10 font-medium text-white' : 'text-brand-100/80 hover:bg-white/5 hover:text-white')
              }
            >
              <n.icon className="size-4 shrink-0" />
              {n.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="border-t border-white/10 p-3 text-[13px]">
        <div className="truncate font-medium text-white">{profile?.full_name || displayLogin(profile?.email)}</div>
        <div className="text-brand-200/70">{perms.role ? ROLE_LABEL[perms.role] : ''}</div>
        <button onClick={signOut} className="mt-2 inline-flex items-center gap-1.5 text-brand-200/80 hover:text-white">
          <LogOut className="size-3.5" /> Выйти
        </button>
      </div>
    </nav>
  )

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="w-64">{sidebar}</div>
          <button className="flex-1 bg-slate-900/40" onClick={() => setOpen(false)} aria-label="Закрыть меню">
            <X className="ml-2 mt-3 size-6 text-white" />
          </button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-3 sm:px-4">
          <button className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Меню">
            <Menu className="size-5" />
          </button>
          <GlobalSearch key={location.pathname} />
          <NotificationsBell />
          <div className="hidden text-right text-[13px] leading-tight md:block">
            <div className="font-medium text-slate-800">{profile?.full_name || displayLogin(profile?.email)}</div>
            <div className="text-slate-500">{perms.role ? ROLE_LABEL[perms.role] : ''}</div>
          </div>
        </header>
        {!online && (
          <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900" role="status">
            Нет подключения к интернету. Изменения не сохранятся, пока связь не восстановится — введённые данные в открытых формах не потеряются.
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-x-hidden p-3 sm:p-5">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
