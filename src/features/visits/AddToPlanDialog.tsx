import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Button, Field, Input, Modal, Select, useToast } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { todayISO } from '@/lib/format'
import { addToPlan } from './api'

/** Добавить выбранные точки в план посещений на дату */
export function AddToPlanDialog({ open, onClose, locationIds }: { open: boolean; onClose: () => void; locationIds: string[] }) {
  const { session } = useAuth()
  const perms = usePerms()
  const d = useDicts()
  const toast = useToast()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [date, setDate] = useState(todayISO(1))
  const [manager, setManager] = useState(session?.user.id ?? '')
  const [purpose, setPurpose] = useState('')
  useEffect(() => { if (open) { setDate(todayISO(1)); setPurpose(''); setManager(session?.user.id ?? '') } }, [open, session])

  const mut = useMutation({
    mutationFn: () => addToPlan(manager, date, locationIds, purpose),
    onSuccess: ({ added }) => {
      toast.success(added ? `Добавлено в план: ${added}` : 'Эти точки уже есть в плане на эту дату')
      qc.invalidateQueries({ queryKey: ['plan'] })
      qc.invalidateQueries({ queryKey: ['location'] })
      onClose()
      nav(`/plan?date=${date}${manager !== session?.user.id ? `&manager=${manager}` : ''}`)
    },
    onError: (e) => toast.error(e),
  })

  return (
    <Modal open={open} onClose={onClose} size="sm" dismissable={!mut.isPending} title="Добавить в план посещений"
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} disabled={!date || !manager} onClick={() => mut.mutate()}>Добавить</Button></>}>
      <div className="space-y-3">
        <Field label="Дата визита" required>{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        {perms.edit_all && (
          <Field label="Сотрудник">
            {(id) => <Select id={id} value={manager} onChange={(e) => setManager(e.target.value)}>{d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}</Select>}
          </Field>
        )}
        <Field label="Цель визита">{(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Знакомство, презентация, сбор потребностей…" maxLength={300} />}</Field>
      </div>
    </Modal>
  )
}
