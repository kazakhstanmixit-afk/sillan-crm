import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Building2, ClipboardList, Loader2, Search, Store, Wrench } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { humanError } from '@/lib/errors'

interface Hit { kind: 'location' | 'company' | 'request' | 'equipment'; id: string; title: string; subtitle: string | null }

const KIND = {
  location: { label: 'Точка', icon: Store, href: (id: string) => `/clients/${id}` },
  company: { label: 'Компания', icon: Building2, href: (id: string) => `/clients?company=${id}` },
  request: { label: 'Заявка', icon: ClipboardList, href: (id: string) => `/requests/${id}` },
  equipment: { label: 'Оборудование', icon: Wrench, href: (id: string) => `/clients/${id}?tab=equipment` },
}

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function GlobalSearch() {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const dq = useDebounced(q.trim())
  const nav = useNavigate()
  const box = useRef<HTMLDivElement>(null)

  const res = useQuery({
    queryKey: ['global-search', dq],
    enabled: dq.length >= 2,
    queryFn: async () => unwrap(await supabase.rpc('global_search', { p_q: dq, p_limit: 6 })) as Hit[],
  })

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const hits = res.data ?? []
  const go = (h: Hit) => {
    setOpen(false)
    setQ('')
    nav(KIND[h.kind].href(h.id))
  }

  return (
    <div ref={box} className="relative max-w-xl flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0) }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          if (e.key === 'Enter' && hits[active]) go(hits[active])
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="Поиск: название, телефон, адрес, контакт, № заявки, оборудование"
        className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-8 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none"
        aria-label="Глобальный поиск"
      />
      {res.isFetching && <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-slate-400" />}
      {open && dq.length >= 2 && (
        <div className="absolute left-0 right-0 top-11 z-50 max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {res.error ? (
            <p className="px-3 py-3 text-sm text-rose-600">{humanError(res.error)}</p>
          ) : !res.isFetching && hits.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-500">Ничего не найдено</p>
          ) : (
            hits.map((h, i) => {
              const K = KIND[h.kind]
              return (
                <button
                  key={h.kind + h.id + i}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(h)}
                  className={`flex w-full items-start gap-2.5 px-3 py-2 text-left ${i === active ? 'bg-brand-50' : ''}`}
                >
                  <K.icon className="mt-0.5 size-4 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-900">{h.title}</span>
                    <span className="block truncate text-xs text-slate-500">{K.label}{h.subtitle ? ` · ${h.subtitle}` : ''}</span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
