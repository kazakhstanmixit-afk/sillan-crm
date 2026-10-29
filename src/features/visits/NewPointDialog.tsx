import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LocateFixed } from 'lucide-react'
import { Button, Field, Input, Modal, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDate } from '@/lib/format'
import { VISIT_LIST_FIELDS, type PlanVisit } from './api'

type Coords = { lat: number; lng: number; acc: number }

/** Новая точка, найденная по пути: сохраняется в «Клиенты» и сразу встаёт в план дня. */
export function NewPointDialog({ open, onClose, managerId, date, onCreated }: {
  open: boolean; onClose: () => void; managerId: string; date: string; onCreated: (v: PlanVisit) => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const key = useRef(crypto.randomUUID())
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [contact, setContact] = useState('')
  const [address, setAddress] = useState('')
  const [coords, setCoords] = useState<Coords | null>(null)
  const [geo, setGeo] = useState<'idle' | 'wait' | 'error'>('idle')

  const locate = () => {
    if (!navigator.geolocation) { setGeo('error'); return }
    setGeo('wait')
    navigator.geolocation.getCurrentPosition(
      (p) => { setCoords({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); setGeo('idle') },
      () => setGeo('error'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    )
  }

  useEffect(() => {
    if (!open) return
    key.current = crypto.randomUUID()
    setName(''); setPhone(''); setContact(''); setAddress(''); setCoords(null)
    locate()
  }, [open])

  const mut = useMutation({
    mutationFn: async () => {
      const r = unwrap(await supabase.rpc('add_found_point', {
        p_manager: managerId, p_date: date,
        p: { client_request_id: key.current, name: name.trim(), phone: phone.trim(), contact_name: contact.trim(), address: address.trim(),
             lat: coords?.lat ?? null, lng: coords?.lng ?? null },
      })) as { visit_id: string; existed: boolean }
      const v = unwrap(await supabase.from('visits').select(VISIT_LIST_FIELDS).eq('id', r.visit_id).single()) as unknown as PlanVisit
      return { v, existed: r.existed }
    },
    onSuccess: ({ v, existed }) => {
      toast.success(existed ? 'Эта точка уже есть в базе — добавлена в план' : 'Новая точка сохранена в «Клиенты» и добавлена в план')
      for (const k of [['plan'], ['clients'], ['visits']]) qc.invalidateQueries({ queryKey: k })
      onCreated(v)
    },
    onError: (e) => toast.error(e),
  })

  return (
    <Modal open={open} onClose={onClose} dismissable={!mut.isPending} title={`Новая точка по пути — ${fmtDate(date)}`}
      footer={<>
        <Button onClick={onClose} disabled={mut.isPending}>Отмена</Button>
        <Button variant="primary" disabled={name.trim().length < 2} loading={mut.isPending} onClick={() => mut.mutate()}>Сохранить и заполнить отчёт</Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Название СТО" required className="sm:col-span-2">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Как написано на вывеске" autoFocus />}</Field>
        <Field label="Телефон">{(id) => <Input id={id} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="+7 ..." />}</Field>
        <Field label="Имя контакта">{(id) => <Input id={id} value={contact} onChange={(e) => setContact(e.target.value)} />}</Field>
        <Field label="Адрес" className="sm:col-span-2">{(id) => <Input id={id} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Улица, дом" />}</Field>
        <div className="flex flex-wrap items-center gap-2 text-sm sm:col-span-2">
          <Button size="sm" icon={<LocateFixed className="size-4" />} loading={geo === 'wait'} onClick={locate}>Я здесь</Button>
          {coords && <span className="text-emerald-700">Место определено (точность ~{Math.round(coords.acc)} м)</span>}
          {!coords && geo === 'error' && <span className="text-amber-700">Не удалось определить место — разрешите доступ к геопозиции или впишите адрес</span>}
          {!coords && geo === 'wait' && <span className="text-slate-500">Определяем место…</span>}
        </div>
        <p className="text-xs text-slate-500 sm:col-span-2">Точка сохранится в «Клиенты» за вами и встанет в план дня. Дальше откроется отчёт о визите — там юрлицо, ЛПР, услуги, оборудование, фото.</p>
      </div>
    </Modal>
  )
}
