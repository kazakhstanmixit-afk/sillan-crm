import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Input, Modal, Spinner, ErrorState } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { searchPattern } from '@/lib/phone'

/** Выбор клиента (точки) — для создания заявки или сделки со страниц «Заявки» и «Сделки» */
export function LocationPickDialog({ open, onClose, onPick, title = 'Выберите клиента' }: {
  open: boolean; onClose: () => void; onPick: (id: string) => void; title?: string
}) {
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  useEffect(() => { if (open) { setQ(''); setDq('') } }, [open])
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t) }, [q])
  const res = useQuery({
    queryKey: ['location-pick', dq],
    enabled: open,
    queryFn: async () => {
      let query = supabase.from('location_list').select('id,name,city,district,address,manager_name').is('archived_at', null)
      if (dq) query = query.ilike('search_text', `%${searchPattern(dq).replace(/[\\%_]/g, (m) => '\\' + m)}%`)
      return unwrap(await query.order('name').limit(30)) as { id: string; name: string; city: string | null; district: string | null; address: string | null; manager_name: string | null }[]
    },
  })
  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название, адрес или телефон клиента" aria-label="Поиск клиента" className="mb-3" />
      {res.isLoading ? <Spinner /> : res.error ? <ErrorState error={res.error} /> : !res.data?.length ? (
        <p className="py-6 text-center text-sm text-slate-500">Ничего не найдено</p>
      ) : (
        <ul className="max-h-[55vh] divide-y divide-slate-100 overflow-y-auto">
          {res.data.map((r) => (
            <li key={r.id}>
              <button className="w-full px-1 py-2 text-left hover:bg-slate-50" onClick={() => onPick(r.id)}>
                <span className="font-medium text-slate-900">{r.name}</span>
                <span className="block text-xs text-slate-500">{[r.city, r.district, r.address].filter(Boolean).join(', ')}{r.manager_name ? ` · ${r.manager_name}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
