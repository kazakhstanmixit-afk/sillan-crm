import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, Input, Modal, Spinner, ErrorState, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { searchPattern } from '@/lib/phone'
import { fmtDate } from '@/lib/format'
import type { LocationListRow } from '@/lib/types'
import { addToPlan } from './api'

/** Выбор точек из базы для плана на день */
export function AddPointsDialog({ open, onClose, managerId, date, existing, onlyOwn }: {
  open: boolean; onClose: () => void; managerId: string; date: string; existing: string[]; onlyOwn: boolean
}) {
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [purpose, setPurpose] = useState('')
  const toast = useToast()
  const qc = useQueryClient()
  useEffect(() => { if (open) { setQ(''); setDq(''); setPicked([]); setPurpose('') } }, [open])
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t) }, [q])

  const res = useQuery({
    queryKey: ['plan-pick', managerId, dq, onlyOwn],
    enabled: open,
    queryFn: async () => {
      let query = supabase.from('location_list').select('id,name,city,address,next_visit_date,last_visit_at,manager_name').is('archived_at', null)
      if (onlyOwn) query = query.eq('manager_id', managerId)
      if (dq) query = query.ilike('search_text', `%${searchPattern(dq).replace(/[\\%_]/g, (m) => '\\' + m)}%`)
      return unwrap(await query.order('last_visit_at', { ascending: true, nullsFirst: true }).limit(50)) as Pick<LocationListRow, 'id' | 'name' | 'city' | 'address' | 'next_visit_date' | 'last_visit_at' | 'manager_name'>[]
    },
  })

  const mut = useMutation({
    mutationFn: () => addToPlan(managerId, date, picked, purpose),
    onSuccess: ({ added }) => {
      toast.success(`Добавлено точек: ${added}`)
      qc.invalidateQueries({ queryKey: ['plan'] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })

  const rows = (res.data ?? []).filter((r) => !existing.includes(r.id))
  return (
    <Modal open={open} onClose={onClose} size="lg" dismissable={!mut.isPending} title={`Добавить точки в план на ${fmtDate(date)}`}
      footer={<>
        <Input className="mr-auto max-w-xs" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Цель визита (для всех выбранных)" aria-label="Цель визита" />
        <Button onClick={onClose} disabled={mut.isPending}>Отмена</Button>
        <Button variant="primary" disabled={!picked.length} loading={mut.isPending} onClick={() => mut.mutate()}>Добавить ({picked.length})</Button>
      </>}>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по названию, адресу, телефону" aria-label="Поиск клиентов" className="mb-3" />
      <p className="mb-2 text-xs text-slate-500">{onlyOwn ? 'Показаны клиенты, закреплённые за сотрудником. ' : ''}Сначала — давно не посещённые.</p>
      {res.isLoading ? <Spinner /> : res.error ? <ErrorState error={res.error} /> : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">Ничего не найдено</p>
      ) : (
        <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <Checkbox
                checked={picked.includes(r.id)}
                onChange={() => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                label={
                  <span>
                    <span className="font-medium text-slate-900">{r.name}</span>
                    <span className="block text-xs text-slate-500">
                      {[r.city, r.address].filter(Boolean).join(', ')} · последний визит: {fmtDate(r.last_visit_at)}
                      {r.next_visit_date && ` · запланирован: ${fmtDate(r.next_visit_date)}`}
                      {!onlyOwn && ` · ${r.manager_name ?? 'без ответственного'}`}
                    </span>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
