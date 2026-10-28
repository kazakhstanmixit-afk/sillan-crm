import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Checkbox, Field, Input, Modal, Select, Spinner, ErrorState, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useDicts } from '@/lib/dictionaries'
import { plural } from '@/lib/format'
import type { LocationListRow } from '@/lib/types'

function useRows(open: boolean, getRows: () => Promise<LocationListRow[]>) {
  const [rows, setRows] = useState<LocationListRow[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    setRows(null)
    setError(null)
    getRows().then((r) => alive && setRows(r)).catch((e) => alive && setError(e))
    return () => { alive = false }
  }, [open, getRows])
  return { rows, error }
}

async function inChunks<T>(items: T[], size: number, fn: (part: T[]) => Promise<number>) {
  let total = 0
  for (let i = 0; i < items.length; i += size) total += await fn(items.slice(i, i + size))
  return total
}

/** Массовое назначение ответственного: предпросмотр распределения → подтверждение */
export function BulkAssignDialog({ open, onClose, getRows, onDone }: {
  open: boolean
  onClose: () => void
  getRows: () => Promise<LocationListRow[]>
  onDone?: () => void
}) {
  const d = useDicts()
  const toast = useToast()
  const qc = useQueryClient()
  const { rows, error } = useRows(open, getRows)
  const [manager, setManager] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setManager(''); setReason('') } }, [open])

  const breakdown = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows ?? []) m.set(r.manager_name ?? 'Без ответственного', (m.get(r.manager_name ?? 'Без ответственного') ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])
  const target = manager === 'none' ? null : manager
  const willChange = (rows ?? []).filter((r) => r.manager_id !== target).length

  const mut = useMutation({
    mutationFn: async () => {
      const ids = (rows ?? []).filter((r) => r.manager_id !== target).map((r) => r.id)
      return inChunks(ids, 500, async (part) => unwrap(await supabase.rpc('assign_locations', { p_ids: part, p_manager: target, p_reason: reason || null })) as number)
    },
    onSuccess: (n) => {
      toast.success(`Ответственный изменён у ${n} ${plural(n, 'клиента', 'клиентов', 'клиентов')}`)
      qc.invalidateQueries({ queryKey: ['clients'] })
      qc.invalidateQueries({ queryKey: ['team'] })
      qc.invalidateQueries({ queryKey: ['location'] })
      onDone?.()
      onClose()
    },
    onError: (e) => toast.error(e),
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissable={!mut.isPending}
      title="Назначить ответственного"
      footer={
        <>
          <Button onClick={onClose} disabled={mut.isPending}>Отмена</Button>
          <Button variant="primary" disabled={!rows || !manager || willChange === 0} loading={mut.isPending} onClick={() => mut.mutate()}>
            Назначить ({willChange})
          </Button>
        </>
      }
    >
      {error ? <ErrorState error={error} /> : !rows ? <Spinner label="Подсчёт выбранных клиентов…" /> : (
        <div className="space-y-4">
          <div className="rounded-md bg-slate-50 p-3 text-sm">
            <p className="font-medium">Выбрано: {rows.length} {plural(rows.length, 'клиент', 'клиента', 'клиентов')}</p>
            <p className="mt-1 text-slate-500">Сейчас закреплены за:</p>
            <ul className="mt-1 space-y-0.5">
              {breakdown.map(([name, n]) => <li key={name} className="flex justify-between"><span>{name}</span><span className="tabular-nums">{n}</span></li>)}
            </ul>
          </div>
          <Field label="Новый ответственный" required>
            {(id) => (
              <Select id={id} value={manager} onChange={(e) => setManager(e.target.value)}>
                <option value="">Выберите сотрудника…</option>
                {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
                <option value="none">— Снять ответственного —</option>
              </Select>
            )}
          </Field>
          <Field label="Причина (необязательно)" hint="Сохраняется в истории назначений">
            {(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}
          </Field>
          {manager && (
            <p className="text-sm text-slate-700">
              Итог: <b>{willChange}</b> {plural(willChange, 'клиент', 'клиента', 'клиентов')} будет закреплено за «{manager === 'none' ? 'без ответственного' : d.profileName(manager)}»
              {rows.length - willChange > 0 && <>, {rows.length - willChange} уже закреплены за ним</>}.
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}

type EditKey = 'status_code' | 'city' | 'district'

/** Массовое изменение допустимых полей */
export function BulkEditDialog({ open, onClose, getRows }: { open: boolean; onClose: () => void; getRows: () => Promise<LocationListRow[]> }) {
  const d = useDicts()
  const toast = useToast()
  const qc = useQueryClient()
  const { rows, error } = useRows(open, getRows)
  const [on, setOn] = useState<Record<EditKey, boolean>>({ status_code: false, city: false, district: false })
  const [val, setVal] = useState<Record<EditKey, string>>({ status_code: '', city: '', district: '' })
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (open) {
      setOn({ status_code: false, city: false, district: false })
      setVal({ status_code: '', city: '', district: '' })
      setConfirm(false)
    }
  }, [open])

  const patch = Object.fromEntries((Object.keys(on) as EditKey[]).filter((k) => on[k]).map((k) => [k, val[k]]))
  const valid = Object.keys(patch).length > 0 && (!on.status_code || val.status_code)

  const mut = useMutation({
    mutationFn: async () => {
      const ids = (rows ?? []).map((r) => r.id)
      return inChunks(ids, 500, async (part) => unwrap(await supabase.rpc('bulk_update_locations', { p_ids: part, p_patch: patch })) as number)
    },
    onSuccess: (n) => {
      toast.success(`Изменено записей: ${n}`)
      qc.invalidateQueries({ queryKey: ['clients'] })
      onClose()
    },
    onError: (e) => toast.error(e),
  })

  const labels: Record<EditKey, string> = { status_code: 'Статус', city: 'Город', district: 'Район' }

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissable={!mut.isPending}
      title="Массовое изменение"
      footer={
        confirm ? (
          <>
            <Button onClick={() => setConfirm(false)} disabled={mut.isPending}>Назад</Button>
            <Button variant="danger" loading={mut.isPending} onClick={() => mut.mutate()}>Подтвердить изменение</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Отмена</Button>
            <Button variant="primary" disabled={!rows || !valid} onClick={() => setConfirm(true)}>Далее</Button>
          </>
        )
      }
    >
      {error ? <ErrorState error={error} /> : !rows ? <Spinner /> : confirm ? (
        <div className="space-y-2 text-sm">
          <p>Будет изменено <b>{rows.length}</b> {plural(rows.length, 'запись', 'записи', 'записей')}:</p>
          <ul className="list-inside list-disc text-slate-700">
            {(Object.keys(patch) as EditKey[]).map((k) => (
              <li key={k}>{labels[k]} → «{k === 'status_code' ? d.clientStatus(val[k])?.name : val[k] || 'пусто'}»</li>
            ))}
          </ul>
          <p className="text-slate-500">Изменения попадут в журнал действий каждой карточки.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Выбрано записей: <b>{rows.length}</b>. Отметьте поля, которые нужно изменить.</p>
          {(Object.keys(labels) as EditKey[]).map((k) => (
            <div key={k} className="grid grid-cols-[140px_1fr] items-center gap-2">
              <Checkbox label={labels[k]} checked={on[k]} onChange={(e) => setOn({ ...on, [k]: e.target.checked })} />
              {k === 'status_code' ? (
                <Select disabled={!on[k]} value={val[k]} onChange={(e) => setVal({ ...val, [k]: e.target.value })} aria-label={labels[k]}>
                  <option value="">Выберите…</option>
                  {d.clientStatuses.filter((s) => s.is_active).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                </Select>
              ) : (
                <Input disabled={!on[k]} value={val[k]} onChange={(e) => setVal({ ...val, [k]: e.target.value })} placeholder="Пусто — очистить поле" aria-label={labels[k]} />
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
