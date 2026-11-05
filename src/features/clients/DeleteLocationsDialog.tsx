import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Field, Input, Modal, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { plural } from '@/lib/format'

/** Удалить точки из базы: пропадают из клиентов, планов и автоплана (в архив, можно восстановить). */
export function DeleteLocationsDialog({ open, onClose, getIds, label, onDone }: {
  open: boolean; onClose: () => void; getIds: () => Promise<string[]> | string[]; label: string; onDone?: () => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) setReason('') }, [open])
  const mut = useMutation({
    mutationFn: async () => {
      const ids = await getIds()
      return unwrap(await supabase.rpc('delete_locations', { p_ids: ids, p_reason: reason.trim() || null })) as number
    },
    onSuccess: (n) => {
      toast.success(`Удалено: ${n} ${plural(n, 'точка', 'точки', 'точек')}`)
      for (const k of [['clients'], ['plan'], ['visits'], ['location']]) qc.invalidateQueries({ queryKey: k })
      onDone?.()
      onClose()
    },
    onError: (e) => toast.error(e),
  })
  return (
    <Modal open={open} onClose={onClose} dismissable={!mut.isPending} title="Удалить из базы?"
      footer={<>
        <Button onClick={onClose} disabled={mut.isPending}>Отмена</Button>
        <Button variant="danger" loading={mut.isPending} onClick={() => mut.mutate()}>Удалить</Button>
      </>}>
      <div className="space-y-3 text-sm">
        <p><b>{label}</b> пропадёт из «Клиентов», из всех будущих планов посещений и из автоплана.</p>
        <p className="text-slate-500">Выполненные визиты и история сохранятся. Если удалили по ошибке — «Клиенты» → галочка «Архив» → открыть точку → «Восстановить».</p>
        <Field label="Причина (необязательно)">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Дубль, закрылась, не наш профиль…" />}</Field>
      </div>
    </Modal>
  )
}
