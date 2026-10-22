import type { ReactNode } from 'react'
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react'
import { cn } from './cn'
import { humanError } from '@/lib/errors'
import { Button } from './Button'

const badgeColors: Record<string, string> = {
  gray: 'bg-slate-100 text-slate-700',
  slate: 'bg-slate-200 text-slate-700',
  blue: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  green: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  orange: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200',
  rose: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200',
  violet: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  brand: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200',
}

export function Badge({ color = 'gray', children, className }: { color?: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium', badgeColors[color] ?? badgeColors.gray, className)}>
      {children}
    </span>
  )
}

export function Card({ title, actions, children, className, bodyClassName }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('rounded-lg border border-slate-200 bg-white', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Spinner({ label = 'Загрузка…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-slate-500', className)} role="status">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  )
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <div className="text-slate-300">{icon ?? <Inbox className="size-8" />}</div>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <div className="max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-6 text-center" role="alert">
      <AlertTriangle className="size-6 text-rose-500" />
      <p className="text-sm text-rose-700">{humanError(error)}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry} icon={<RefreshCw className="size-3.5" />}>
          Повторить
        </Button>
      )}
    </div>
  )
}

/** Состояния запроса: загрузка, ошибка, пусто — в одном месте */
export function QueryState({ query, empty, emptyTitle = 'Нет данных', emptyText, children }: {
  query: { isLoading: boolean; error: unknown; refetch: () => unknown }
  empty?: boolean
  emptyTitle?: string
  emptyText?: ReactNode
  children: ReactNode
}) {
  if (query.isLoading) return <Spinner />
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  if (empty) return <EmptyState title={emptyTitle}>{emptyText}</EmptyState>
  return <>{children}</>
}

export function Stat({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'warn' | 'ok'; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} className={cn('rounded-lg border border-slate-200 bg-white p-3 text-left', onClick && 'hover:border-brand-300')}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums', tone === 'warn' ? 'text-rose-600' : tone === 'ok' ? 'text-emerald-700' : 'text-slate-900')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </Tag>
  )
}

/** Горизонтальные полосы — распределение (по направлениям, городам и т.п.) */
export function BarList({ items, emptyText = 'Нет данных' }: { items: { label: string; value: number; onClick?: () => void }[]; emptyText?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (!items.length || items.every((i) => i.value === 0)) return <p className="py-4 text-center text-sm text-slate-400">{emptyText}</p>
  return (
    <ul className="space-y-1.5">
      {items.map((i) => (
        <li key={i.label}>
          <button type="button" onClick={i.onClick} disabled={!i.onClick} className="group w-full text-left disabled:cursor-default">
            <div className="flex justify-between gap-2 text-[13px]">
              <span className="truncate text-slate-700 group-enabled:group-hover:text-brand-700">{i.label}</span>
              <span className="tabular-nums text-slate-500">{i.value}</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded bg-slate-100">
              <div className="h-1.5 rounded bg-brand-500" style={{ width: `${(i.value / max) * 100}%` }} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-slate-200 px-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={cn(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
            t.value === value ? 'border-brand-600 font-medium text-brand-800' : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded bg-slate-100 px-1.5 text-xs text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px] text-slate-600">
      <span>
        {from}–{to} из {total.toLocaleString('ru-RU')}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(1)} aria-label="Первая страница">«</Button>
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>Назад</Button>
        <span className="px-2 tabular-nums">
          {page} / {pages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>Вперёд</Button>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(pages)} aria-label="Последняя страница">»</Button>
      </div>
    </div>
  )
}

/** Строка «подпись — значение» в карточках */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(110px,40%)_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-slate-900">{children || children === 0 ? children : <span className="text-slate-400">—</span>}</dd>
    </div>
  )
}
