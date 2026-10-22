import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Modal, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { todayISO } from '@/lib/format'
import type { Visit } from '@/lib/types'

export type StatusAction = 'rescheduled' | 'cancelled' | 'failed' | 'planned'

const TITLES: Record<StatusAction, string> = {
  rescheduled: 'Перенести визит',
  cancelled: 'Отменить визит',
  failed: 'Визит не состоялся',
  planned: 'Вернуть визит в план',
}

export function VisitStatusDialog({ visit, action, onClose }: { visit: Visit; action: StatusAction; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [date, setDate] = useState(todayISO(1))
  const toast = useToast()
  const qc = useQueryClient()
  useEffect(() => { setReason(''); setDate(todayISO(1)) }, [visit.id, action])

  const mut = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('set_visit_status', { p_visit: visit.id, p_status: action, p_reason: reason || null, p_new_date: action === 'rescheduled' ? date : null })),
    onSuccess: () => {
      toast.success(action === 'rescheduled' ? 'Визит перенесён' : 'Статус визита изменён')
      qc.invalidateQueries({ queryKey: ['plan'] })
      qc.invalidateQueries({ queryKey: ['visits'] })
      qc.invalidateQueries({ queryKey: ['location', visit.location_id] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })
  const needReason = action !== 'planned'
  return (
    <Modal open size="sm" onClose={onClose} dismissable={!mut.isPending} title={TITLES[action]}
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant={action === 'cancelled' ? 'danger' : 'primary'} loading={mut.isPending} disabled={(action === 'rescheduled' && !date) || (needReason && !reason.trim())} onClick={() => mut.mutate()}>Сохранить</Button></>}>
      <div className="space-y-3">
        {action === 'rescheduled' && <Field label="Новая дата" required>{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>}
        {needReason && <Field label="Причина" required>{(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>}
        {action === 'rescheduled' && <p className="text-xs text-slate-500">Текущий визит получит статус «Перенесён», а на новую дату будет создан запланированный визит.</p>}
      </div>
    </Modal>
  )
}

export function VisitEditDialog({ visit, onClose }: { visit: Visit; onClose: () => void }) {
  const [purpose, setPurpose] = useState(visit.purpose ?? '')
  const [prep, setPrep] = useState(visit.prep_notes ?? '')
  const toast = useToast()
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: async () => {
      const rows = unwrap(await supabase.from('visits').update({ purpose: purpose.trim() || null, prep_notes: prep.trim() || null }).eq('id', visit.id).select('id'))
      if (!rows?.length) throw new Error('Недостаточно прав')
    },
    onSuccess: () => { toast.success('Сохранено'); qc.invalidateQueries({ queryKey: ['plan'] }); onClose() },
    onError: (e) => toast.error(e),
  })
  return (
    <Modal open size="sm" onClose={onClose} dismissable={!mut.isPending} title="Цель и подготовка"
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Сохранить</Button></>}>
      <div className="space-y-3">
        <Field label="Цель визита">{(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={300} />}</Field>
        <Field label="Подготовительные заметки">{(id) => <Textarea id={id} value={prep} onChange={(e) => setPrep(e.target.value)} maxLength={3000} />}</Field>
      </div>
    </Modal>
  )
}
