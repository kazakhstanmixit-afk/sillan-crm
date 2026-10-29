import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, Input, Modal, Select, Spinner, ErrorState, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { searchPattern } from '@/lib/phone'
import { fmtDate } from '@/lib/format'
import { useDicts } from '@/lib/dictionaries'
import { distanceKm, fmtKm, hasCoords, type GeoPoint } from '@/lib/geo'
import type { LocationListRow } from '@/lib/types'
import { fetchFilterOptions } from '@/features/clients/api'
import { addToPlan } from './api'

type Row = Pick<LocationListRow, 'id' | 'name' | 'city' | 'district' | 'address' | 'lat' | 'lng' | 'next_visit_date' | 'last_visit_at' | 'manager_name' | 'direction_ids'>
type Sort = 'near' | 'stale' | 'name'

/** Выбор точек из базы для плана на день: поиск, район, направление, «рядом с точками плана» */
export function AddPointsDialog({ open, onClose, managerId, date, existing, onlyOwn, anchors = [], onNewPoint }: {
  open: boolean; onClose: () => void; managerId: string; date: string; existing: string[]; onlyOwn: boolean; anchors?: GeoPoint[]; onNewPoint?: () => void
}) {
  const d = useDicts()
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [district, setDistrict] = useState('')
  const [direction, setDirection] = useState('')
  // по умолчанию — клиенты сотрудника, чей это план; руководство может выбрать всех или без ответственного
  const [owner, setOwner] = useState(managerId)
  const [sort, setSort] = useState<Sort>(anchors.length ? 'near' : 'stale')
  const [picked, setPicked] = useState<string[]>([])
  const [purpose, setPurpose] = useState('')
  const toast = useToast()
  const qc = useQueryClient()
  useEffect(() => {
    if (open) { setQ(''); setDq(''); setPicked([]); setPurpose(''); setSort(anchors.length ? 'near' : 'stale'); setOwner(managerId) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t) }, [q])

  const options = useQuery({ queryKey: ['clients', 'options'], queryFn: fetchFilterOptions, enabled: open, staleTime: 5 * 60_000 })

  const res = useQuery({
    queryKey: ['plan-pick', managerId, dq, onlyOwn, owner, district, direction, sort],
    enabled: open,
    queryFn: async () => {
      let query = supabase.from('location_list').select('id,name,city,district,address,lat,lng,next_visit_date,last_visit_at,manager_name,direction_ids').is('archived_at', null)
      if (onlyOwn) query = query.eq('manager_id', managerId)
      else if (owner === 'none') query = query.is('manager_id', null)
      else if (owner) query = query.eq('manager_id', owner)
      if (dq) query = query.ilike('search_text', `%${searchPattern(dq).replace(/[\\%_]/g, (m) => '\\' + m)}%`)
      if (district) query = query.eq('district', district)
      if (direction) query = query.contains('direction_ids', [direction])
      if (sort === 'name') query = query.order('name')
      else query = query.order('last_visit_at', { ascending: true, nullsFirst: true }).order('name')
      // для сортировки по близости берём больше кандидатов и сортируем на месте
      return unwrap(await query.limit(sort === 'near' ? 3000 : 150)) as Row[]
    },
  })

  const rows = useMemo(() => {
    const list = (res.data ?? []).filter((r) => !existing.includes(r.id)).map((r) => ({
      ...r,
      km: anchors.length && hasCoords(r) ? Math.min(...anchors.map((a) => distanceKm(a, r))) : null,
    }))
    if (sort === 'near') list.sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity))
    return list.slice(0, 150)
  }, [res.data, existing, anchors, sort])

  const mut = useMutation({
    mutationFn: () => addToPlan(managerId, date, picked, purpose),
    onSuccess: ({ added }) => {
      toast.success(`Добавлено точек: ${added}`)
      qc.invalidateQueries({ queryKey: ['plan'] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })

  const districts = options.data?.districts ?? []
  return (
    <Modal open={open} onClose={onClose} size="lg" dismissable={!mut.isPending} title={`Добавить точки в план на ${fmtDate(date)}`}
      footer={<>
        <Input className="mr-auto max-w-xs" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Цель визита (для всех выбранных)" aria-label="Цель визита" />
        <Button onClick={onClose} disabled={mut.isPending}>Отмена</Button>
        <Button variant="primary" disabled={!picked.length} loading={mut.isPending} onClick={() => mut.mutate()}>Добавить ({picked.length})</Button>
      </>}>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <Input className="sm:col-span-2" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по названию, адресу, телефону" aria-label="Поиск клиентов" />
        {onNewPoint && <button type="button" className="text-left text-sm text-brand-700 hover:underline sm:col-span-2" onClick={onNewPoint}>Точки нет в базе? Добавить новую точку</button>}
        <Select value={district} onChange={(e) => setDistrict(e.target.value)} aria-label="Район">
          <option value="">Все районы</option>
          {districts.map((x) => <option key={x.city + x.district} value={x.district}>{x.district}{districts.some((y) => y.city !== x.city) ? ` (${x.city})` : ''}</option>)}
        </Select>
        <Select value={direction} onChange={(e) => setDirection(e.target.value)} aria-label="Направление">
          <option value="">Все направления</option>
          {d.activeDirections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
        {!onlyOwn && (
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Ответственный">
            {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}{p.id === managerId ? ' — владелец плана' : ''}</option>)}
            <option value="none">Без ответственного</option>
            <option value="">Все клиенты</option>
          </Select>
        )}
        <Select className={onlyOwn ? 'sm:col-span-2' : ''} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Сортировка">
          <option value="near" disabled={!anchors.length}>Ближе к точкам плана{anchors.length ? '' : ' (сначала добавьте точку с координатами)'}</option>
          <option value="stale">Сначала давно не посещённые</option>
          <option value="name">По названию</option>
        </Select>
      </div>
      <p className="mb-2 text-xs text-slate-500">{onlyOwn || owner === managerId ? 'Показаны клиенты, закреплённые за сотрудником этого плана. ' : ''}Расстояние — по прямой до ближайшей точки плана.</p>
      {res.isLoading ? <Spinner /> : res.error ? <ErrorState error={res.error} /> : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">Ничего не найдено</p>
      ) : (
        <ul className="max-h-[45vh] divide-y divide-slate-100 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <Checkbox
                checked={picked.includes(r.id)}
                onChange={() => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                label={
                  <span>
                    <span className="font-medium text-slate-900">{r.name}</span>
                    {r.km !== null && <span className="ml-2 text-xs font-medium text-brand-700">{fmtKm(r.km)}</span>}
                    <span className="block text-xs text-slate-500">
                      {[r.district, r.address].filter(Boolean).join(', ')} · последний визит: {fmtDate(r.last_visit_at)}
                      {r.next_visit_date && ` · запланирован: ${fmtDate(r.next_visit_date)}`}
                      {!onlyOwn && owner !== managerId && ` · ${r.manager_name ?? 'без ответственного'}`}
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
