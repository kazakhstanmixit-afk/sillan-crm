import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Pencil } from 'lucide-react'
import { Badge, Button, Card, Checkbox, ConfirmDialog, Field, Input, QueryState, Select, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { COMMENT_KIND_LABEL } from '@/lib/labels'
import type { Comment } from '@/lib/types'
import { clientKeys } from '../api'

export function CommentsTab({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const key = clientKeys(locationId).comments
  const d = useDicts()
  const perms = usePerms()
  const { session } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [kind, setKind] = useState('comment')
  const [body, setBody] = useState('')
  const [next, setNext] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [archiving, setArchiving] = useState<Comment | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [kindFilter, setKindFilter] = useState('')

  const q = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase.from('comments').select('*').eq('location_id', locationId).order('created_at', { ascending: false })) as Comment[],
  })
  const list = (q.data ?? []).filter((c) => (showArchived || !c.archived_at) && (!kindFilter || c.kind === kindFilter))

  const invalidate = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['location', locationId] }) }
  const add = useMutation({
    mutationFn: async () => unwrap(await supabase.from('comments').insert({ location_id: locationId, kind, body: body.trim(), next_contact_date: next || null }).select('id')),
    onSuccess: () => { toast.success('Запись добавлена'); setBody(''); setNext(''); invalidate() },
    onError: (e) => toast.error(e),
  })
  const update = useMutation({
    mutationFn: async (v: { id: string; patch: Partial<Comment> }) => {
      const rows = unwrap(await supabase.from('comments').update(v.patch).eq('id', v.id).select('id'))
      if (!rows?.length) throw new Error('Изменить запись может только автор или руководитель')
    },
    onSuccess: () => { toast.success('Сохранено'); setEditing(null); setArchiving(null); invalidate() },
    onError: (e) => toast.error(e),
  })

  return (
    <div className="space-y-4">
      {canEdit && (
        <Card title="Новая запись">
          <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate() }} className="grid gap-3 sm:grid-cols-[220px_1fr]">
            <Field label="Тип">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(COMMENT_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label="Текст" required>{(id) => <Textarea id={id} rows={2} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />}</Field>
            <Field label="Дата следующего контакта" hint="Попадёт в карточку клиента">{(id) => <Input id={id} type="date" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
            <div className="flex items-end justify-end"><Button type="submit" variant="primary" disabled={!body.trim()} loading={add.isPending}>Добавить</Button></div>
          </form>
        </Card>
      )}
      <Card
        title="Комментарии и договорённости"
        actions={<>
          <Select className="h-8 w-auto" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="Тип записи">
            <option value="">Все типы</option>
            {Object.entries(COMMENT_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Checkbox label="Архивные" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        </>}
      >
        <QueryState query={q} empty={!list.length} emptyTitle="Записей пока нет">
          <ul className="space-y-3">
            {list.map((c) => {
              const mine = c.author_id === session?.user.id
              return (
                <li key={c.id} className={`rounded-md border border-slate-100 p-3 ${c.archived_at ? 'opacity-50' : ''}`}>
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Badge color={c.kind === 'comment' ? 'gray' : 'brand'}>{COMMENT_KIND_LABEL[c.kind]}</Badge>
                    <span>{d.profileName(c.author_id)}</span>
                    <span>{fmtDateTime(c.created_at)}</span>
                    {c.updated_at !== c.created_at && <span>(изменено {fmtDateTime(c.updated_at)})</span>}
                    {c.next_contact_date && <span className="text-slate-700">Следующий контакт: {fmtDate(c.next_contact_date)}</span>}
                    {c.archived_at && <Badge color="slate">Архив</Badge>}
                  </div>
                  {editing?.id === c.id ? (
                    <div className="space-y-2">
                      <Textarea value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} aria-label="Текст записи" />
                      <div className="flex justify-end gap-2">
                        <Button size="sm" onClick={() => setEditing(null)}>Отмена</Button>
                        <Button size="sm" variant="primary" disabled={!editing.body.trim()} loading={update.isPending} onClick={() => update.mutate({ id: c.id, patch: { body: editing.body.trim() } })}>Сохранить</Button>
                      </div>
                    </div>
                  ) : <p className="whitespace-pre-line text-sm text-slate-800">{c.body}</p>}
                  {!c.archived_at && editing?.id !== c.id && ((mine && canEdit) || perms.edit_all) && (
                    <div className="mt-1 flex gap-1">
                      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing({ id: c.id, body: c.body })}>Изменить</Button>
                      <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} onClick={() => setArchiving(c)}>В архив</Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </QueryState>
        <p className="mt-3 text-xs text-slate-400">Записи не удаляются: исправления и архивирование сохраняются в истории карточки.</p>
      </Card>
      <ConfirmDialog open={!!archiving} title="Перенести запись в архив?" confirmText="В архив" loading={update.isPending} onClose={() => setArchiving(null)} onConfirm={() => archiving && update.mutate({ id: archiving.id, patch: { archived_at: new Date().toISOString() } })}>
        Запись скроется из списка, но останется в истории.
      </ConfirmDialog>
    </div>
  )
}
