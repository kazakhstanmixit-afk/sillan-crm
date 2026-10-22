import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Building2, Plus, X } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { Input } from '@/components/ui'

export type CompanyChoice =
  | { kind: 'none' }
  | { kind: 'existing'; id: string; name: string }
  | { kind: 'new'; name: string }

/** Выбор юрлица: существующая компания, новая или без компании */
export function CompanyPicker({ value, onChange }: { value: CompanyChoice; onChange: (v: CompanyChoice) => void }) {
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const res = useQuery({
    queryKey: ['company-search', dq],
    enabled: dq.length >= 2,
    queryFn: async () =>
      unwrap(await supabase.from('companies').select('id, name, legal_name, bin').is('archived_at', null)
        .or(`name.ilike.%${dq.replace(/[,()%_\\]/g, ' ')}%,legal_name.ilike.%${dq.replace(/[,()%_\\]/g, ' ')}%`).order('name').limit(8)) as
        { id: string; name: string; legal_name: string | null; bin: string | null }[],
  })

  if (value.kind !== 'none') {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm">
        <span className="flex items-center gap-2">
          <Building2 className="size-4 text-slate-400" />
          {value.name}
          {value.kind === 'new' && <span className="text-xs text-emerald-700">(будет создана)</span>}
        </span>
        <button type="button" onClick={() => onChange({ kind: 'none' })} className="text-slate-400 hover:text-slate-700" aria-label="Убрать компанию">
          <X className="size-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Начните вводить название компании или юрлица" aria-label="Компания" />
      {open && dq.length >= 2 && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {res.data?.map((c) => (
            <button key={c.id} type="button" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50" onMouseDown={() => { onChange({ kind: 'existing', id: c.id, name: c.name }); setQ('') }}>
              {c.name}
              <span className="ml-2 text-xs text-slate-500">{[c.legal_name, c.bin].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          <button type="button" className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-brand-700 hover:bg-slate-50" onMouseDown={() => { onChange({ kind: 'new', name: q.trim() }); setQ('') }}>
            <Plus className="size-3.5" /> Создать компанию «{q.trim()}»
          </button>
        </div>
      )}
    </div>
  )
}
