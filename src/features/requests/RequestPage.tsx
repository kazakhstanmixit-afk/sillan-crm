import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Download, Paperclip, Trash2 } from 'lucide-react'
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, InfoRow, Input, Select, Spinner, Textarea, useToast } from '@/components/ui'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDateTime, fmtMoney } from '@/lib/format'
import { ATTACHMENT_TYPES, compressImage, removeFile, signedUrls, uploadFile, validateFile } from '@/lib/files'
import { REQUEST_KIND_LABEL, URGENCY_COLOR, URGENCY_LABEL } from '@/lib/labels'
import type { Request } from '@/lib/types'

type Full = Request & { location: { id: string; name: string; city: string | null } | null; contact: { full_name: string | null; phone: string | null } | null }
interface Attachment { id: string; storage_path: string; file_name: string | null; mime_type: string | null; size_bytes: number | null; uploaded_by: string | null; created_at: string }

export default function RequestPage() {
  const { id = '' } = useParams()
  const d = useDicts()
  const perms = usePerms()
  const { session } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const key = ['requests', 'one', id]

  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [req, history, comments, files] = await Promise.all([
        supabase.from('requests').select('*, location:locations(id,name,city), contact:contacts(full_name,phone)').eq('id', id).maybeSingle(),
        supabase.from('request_status_history').select('*').eq('request_id', id).order('created_at'),
        supabase.from('request_comments').select('*').eq('request_id', id).order('created_at'),
        supabase.from('request_attachments').select('*').eq('request_id', id).order('created_at'),
      ])
      const attachments = unwrap(files) as Attachment[]
      return {
        req: unwrap(req) as Full | null,
        history: unwrap(history) as { id: string; from_status: string | null; to_status: string; comment: string | null; changed_by: string | null; created_at: string }[],
        comments: unwrap(comments) as { id: string; body: string; author_id: string | null; created_at: string }[],
        attachments,
        urls: await signedUrls(attachments.map((a) => a.storage_path)),
      }
    },
  })

  const [status, setStatus] = useState('')
  const [statusComment, setStatusComment] = useState('')
  const [comment, setComment] = useState('')
  const [deleting, setDeleting] = useState<Attachment | null>(null)
  const invalidate = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['requests'] }); qc.invalidateQueries({ queryKey: ['notifications'] }) }

  const changeStatus = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('change_request_status', { p_request: id, p_status: status, p_comment: statusComment || null })),
    onSuccess: () => { toast.success('Статус изменён'); setStatus(''); setStatusComment(''); invalidate() },
    onError: (e) => toast.error(e),
  })
  const assign = useMutation({
    mutationFn: async (patch: { assignee_id: string | null; assignee_name?: string | null }) => {
      const rows = unwrap(await supabase.from('requests').update(patch).eq('id', id).select('id'))
      if (!rows?.length) throw new Error('Недостаточно прав')
    },
    onSuccess: () => { toast.success('Ответственный сохранён'); invalidate() },
    onError: (e) => toast.error(e),
  })
  const addComment = useMutation({
    mutationFn: async () => unwrap(await supabase.from('request_comments').insert({ request_id: id, body: comment.trim(), author_id: session!.user.id }).select('id')),
    onSuccess: () => { setComment(''); invalidate() },
    onError: (e) => toast.error(e),
  })
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const errors: string[] = []
      for (const raw of files) {
        const bad = validateFile(raw, ATTACHMENT_TYPES)
        if (bad) { errors.push(bad); continue }
        const f = raw.type.startsWith('image/') ? await compressImage(raw) : raw
        let path: string | null = null
        try {
          path = await uploadFile('requests', id, f)
          unwrap(await supabase.from('request_attachments').insert({ request_id: id, storage_path: path, file_name: raw.name, mime_type: f.type, size_bytes: f.size }).select('id'))
        } catch (e) {
          if (path) await removeFile(path).catch(() => undefined)
          errors.push(`«${raw.name}»: ${(e as Error).message}`)
        }
      }
      return errors
    },
    onSuccess: (errors) => { errors.forEach((e) => toast.error(e)); if (!errors.length) toast.success('Файлы прикреплены'); invalidate() },
    onError: (e) => toast.error(e),
  })
  const delFile = useMutation({
    mutationFn: async (a: Attachment) => {
      const rows = unwrap(await supabase.from('request_attachments').delete().eq('id', a.id).select('id'))
      if (!rows?.length) throw new Error('Удалить файл может автор загрузки или руководитель')
      await removeFile(a.storage_path)
    },
    onSuccess: () => { toast.success('Файл удалён'); setDeleting(null); invalidate() },
    onError: (e) => toast.error(e),
  })

  if (q.isLoading) return <Spinner />
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const r = q.data?.req
  if (!r) return <EmptyState title="Заявка не найдена">Возможно, у вас нет доступа к этой заявке. <Link to="/requests" className="text-brand-600 underline">К списку заявок</Link></EmptyState>

  const st = d.requestStatus(r.status_code)
  const canWork = perms.edit_all || r.initiator_id === session?.user.id || r.assignee_id === session?.user.id

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link to="/requests" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="size-4" /> Все заявки</Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Заявка {r.number}</h1>
        <Badge color="brand">{REQUEST_KIND_LABEL[r.kind]}</Badge>
        <Badge color={st?.color}>{st?.name ?? r.status_code}</Badge>
        <Badge color={URGENCY_COLOR[r.urgency]}>Срочность: {URGENCY_LABEL[r.urgency]}</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-4">
          <Card title="Что требуется">
            <dl>
              <InfoRow label="Клиент">{r.location && <Link to={`/clients/${r.location.id}`} className="text-brand-700 hover:underline">{r.location.name}</Link>}{r.location?.city && `, ${r.location.city}`}</InfoRow>
              <InfoRow label="Контактное лицо">{r.contact && [r.contact.full_name, r.contact.phone].filter(Boolean).join(', ')}</InfoRow>
              <InfoRow label={r.kind === 'equipment' ? 'Оборудование / решение' : 'Запчасть'}>{r.item_name}</InfoRow>
              {r.kind === 'equipment' && <InfoRow label="Категория">{r.category_id ? d.categoryName(r.category_id) : null}</InfoRow>}
              <InfoRow label={r.kind === 'equipment' ? 'Бренд' : 'Производитель'}>{r.brand}</InfoRow>
              {r.kind === 'equipment' ? <InfoRow label="Модель">{r.model}</InfoRow> : <InfoRow label="Артикул">{r.article}</InfoRow>}
              <InfoRow label="Количество">{r.quantity}</InfoRow>
              {r.kind === 'equipment' && <InfoRow label="Бюджет">{r.budget ? fmtMoney(r.budget) : null}</InfoRow>}
              <InfoRow label="Описание">{r.description && <span className="whitespace-pre-line">{r.description}</span>}</InfoRow>
              <InfoRow label="Комментарий">{r.comment}</InfoRow>
              <InfoRow label="Инициатор">{d.profileName(r.initiator_id)}</InfoRow>
              <InfoRow label="Создана">{fmtDateTime(r.created_at)}</InfoRow>
              {r.closed_at && <InfoRow label="Закрыта">{fmtDateTime(r.closed_at)}</InfoRow>}
            </dl>
          </Card>

          <Card title="Файлы и фото" actions={canWork && (
            <>
              <input ref={fileInput} type="file" multiple hidden accept={ATTACHMENT_TYPES.join(',')} onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) upload.mutate(f) }} />
              <Button size="sm" icon={<Paperclip className="size-3.5" />} loading={upload.isPending} onClick={() => fileInput.current?.click()}>Прикрепить</Button>
            </>
          )}>
            {!q.data?.attachments.length ? <p className="text-sm text-slate-500">Файлов нет. Фото, PDF, Excel или Word — до 10 МБ.</p> : (
              <ul className="divide-y divide-slate-100">
                {q.data.attachments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <a href={q.data.urls[a.storage_path]} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-2 text-brand-700 hover:underline">
                      {a.mime_type?.startsWith('image/') && q.data.urls[a.storage_path]
                        ? <img src={q.data.urls[a.storage_path]} alt="" className="size-10 rounded object-cover" />
                        : <Download className="size-4" />}
                      <span className="truncate">{a.file_name ?? 'Файл'}</span>
                    </a>
                    <span className="flex items-center gap-2 text-xs text-slate-500">
                      {d.profileName(a.uploaded_by)} · {fmtDateTime(a.created_at)}
                      {(a.uploaded_by === session?.user.id || perms.edit_all) && <Button size="sm" variant="ghost" aria-label="Удалить файл" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(a)} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Комментарии">
            <ul className="mb-3 space-y-2">
              {q.data?.comments.length === 0 && <li className="text-sm text-slate-500">Комментариев пока нет.</li>}
              {q.data?.comments.map((c) => (
                <li key={c.id} className="rounded-md bg-slate-50 p-2.5 text-sm">
                  <div className="text-xs text-slate-500">{d.profileName(c.author_id)} · {fmtDateTime(c.created_at)}</div>
                  <p className="whitespace-pre-line">{c.body}</p>
                </li>
              ))}
            </ul>
            <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) addComment.mutate() }} className="flex gap-2">
              <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Написать комментарий" aria-label="Комментарий" maxLength={3000} />
              <Button type="submit" variant="primary" disabled={!comment.trim()} loading={addComment.isPending} className="self-end">Отправить</Button>
            </form>
          </Card>
        </div>

        <div className="space-y-4">
          {canWork && (
            <Card title="Статус и ответственный">
              <div className="space-y-3">
                <Field label="Новый статус">
                  {(fid) => (
                    <Select id={fid} value={status} onChange={(e) => setStatus(e.target.value)}>
                      <option value="">Выберите…</option>
                      {d.requestStatuses.filter((s) => s.is_active && s.code !== r.status_code).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                    </Select>
                  )}
                </Field>
                {status && <Field label="Комментарий к смене статуса">{(fid) => <Input id={fid} value={statusComment} onChange={(e) => setStatusComment(e.target.value)} maxLength={500} />}</Field>}
                <Button variant="primary" disabled={!status} loading={changeStatus.isPending} onClick={() => changeStatus.mutate()}>Изменить статус</Button>
                <Field label="Ответственный сотрудник отдела" hint={r.assignee_name && !r.assignee_id ? `Без учётной записи: ${r.assignee_name}` : undefined}>
                  {(fid) => (
                    <Select id={fid} value={r.assignee_id ?? ''} disabled={assign.isPending} onChange={(e) => assign.mutate({ assignee_id: e.target.value || null })}>
                      <option value="">Не назначен</option>
                      {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
                    </Select>
                  )}
                </Field>
              </div>
            </Card>
          )}
          <Card title="История статусов">
            <ol className="space-y-2 text-sm">
              {q.data?.history.map((h) => (
                <li key={h.id} className="border-l-2 border-brand-200 pl-3">
                  <div className="text-xs text-slate-500">{fmtDateTime(h.created_at)} · {h.changed_by ? d.profileName(h.changed_by) : 'Система'}</div>
                  <div>{h.from_status ? `${d.requestStatus(h.from_status)?.name ?? h.from_status} → ` : 'Создана: '}<b>{d.requestStatus(h.to_status)?.name ?? h.to_status}</b></div>
                  {h.comment && <div className="text-xs text-slate-600">{h.comment}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      <ConfirmDialog open={!!deleting} title="Удалить файл?" danger confirmText="Удалить" loading={delFile.isPending} onClose={() => setDeleting(null)} onConfirm={() => deleting && delFile.mutate(deleting)}>
        «{deleting?.file_name}» будет удалён без возможности восстановления.
      </ConfirmDialog>
    </div>
  )
}
