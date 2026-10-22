import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Trash2 } from 'lucide-react'
import { Button, Card, ConfirmDialog, Field, Input, Modal, QueryState, Textarea, useToast } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { useAuth, usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { fmtDateTime } from '@/lib/format'
import { IMAGE_TYPES, compressImage, removeFile, signedUrls, uploadFile, validateFile } from '@/lib/files'
import type { Photo } from '@/lib/types'
import { clientKeys } from '../api'

/** Загрузка фото точки (используется и в результате визита) */
export async function uploadLocationPhotos(locationId: string, files: File[], visitId?: string | null) {
  const errors: string[] = []
  let ok = 0
  for (const raw of files) {
    const bad = validateFile(raw, IMAGE_TYPES)
    if (bad) { errors.push(bad); continue }
    const f = await compressImage(raw)
    let path: string | null = null
    try {
      path = await uploadFile('locations', locationId, f)
      unwrap(await supabase.from('location_photos').insert({ location_id: locationId, visit_id: visitId ?? null, storage_path: path, mime_type: f.type, size_bytes: f.size }).select('id'))
      ok++
    } catch (e) {
      if (path) await removeFile(path).catch(() => undefined) // не оставляем файл без записи
      errors.push(`«${raw.name}»: ${(e as Error).message}`)
    }
  }
  return { ok, errors }
}

export function PhotosTab({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const key = clientKeys(locationId).photos
  const qc = useQueryClient()
  const toast = useToast()
  const d = useDicts()
  const perms = usePerms()
  const { session } = useAuth()
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState<Photo | null>(null)
  const [deleting, setDeleting] = useState<Photo | null>(null)

  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const photos = unwrap(await supabase.from('location_photos').select('*').eq('location_id', locationId).order('created_at', { ascending: false })) as Photo[]
      const urls = await signedUrls(photos.map((p) => p.storage_path))
      return { photos, urls }
    },
    staleTime: 30 * 60_000,
  })

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadLocationPhotos(locationId, files),
    onSuccess: ({ ok, errors }) => {
      if (ok) toast.success(`Загружено фото: ${ok}`)
      errors.forEach((e) => toast.error(e))
      qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) => toast.error(e),
  })

  const del = useMutation({
    mutationFn: async (p: Photo) => {
      const rows = unwrap(await supabase.from('location_photos').delete().eq('id', p.id).select('id'))
      if (!rows?.length) throw new Error('Удалить фото может автор загрузки или руководитель')
      await removeFile(p.storage_path)
    },
    onSuccess: () => { toast.success('Фото удалено'); setDeleting(null); setOpen(null); qc.invalidateQueries({ queryKey: key }) },
    onError: (e) => toast.error(e),
  })

  const photos = q.data?.photos ?? []
  return (
    <Card
      title="Фотографии"
      actions={canEdit && (
        <>
          <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) upload.mutate(f) }} />
          <Button size="sm" variant="primary" icon={<ImagePlus className="size-3.5" />} loading={upload.isPending} onClick={() => input.current?.click()}>Загрузить фото</Button>
        </>
      )}
    >
      <QueryState query={q} empty={!photos.length} emptyTitle="Фотографий пока нет" emptyText="Фасад, посты, оборудование — до 10 МБ на файл. Крупные фото автоматически уменьшаются.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {photos.map((p) => (
            <button key={p.id} onClick={() => setOpen(p)} className="group overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-left">
              <img src={q.data?.urls[p.storage_path]} alt={p.caption ?? 'Фото точки'} loading="lazy" className="aspect-square w-full object-cover transition-transform group-hover:scale-105" />
              <div className="truncate px-2 py-1 text-xs text-slate-600">{p.caption || fmtDateTime(p.created_at)}</div>
            </button>
          ))}
        </div>
      </QueryState>
      {open && (
        <PhotoModal
          photo={open}
          url={q.data?.urls[open.storage_path]}
          author={d.profileName(open.uploaded_by)}
          canEdit={canEdit}
          canDelete={canEdit && (open.uploaded_by === session?.user.id || perms.edit_all)}
          onClose={() => setOpen(null)}
          onDelete={() => setDeleting(open)}
        />
      )}
      <ConfirmDialog open={!!deleting} title="Удалить фото?" danger confirmText="Удалить" loading={del.isPending} onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting)}>
        Фото будет удалено без возможности восстановления.
      </ConfirmDialog>
    </Card>
  )
}

function PhotoModal({ photo, url, author, canEdit, canDelete, onClose, onDelete }: {
  photo: Photo; url?: string; author: string; canEdit: boolean; canDelete: boolean; onClose: () => void; onDelete: () => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const [caption, setCaption] = useState(photo.caption ?? '')
  const [comment, setComment] = useState(photo.comment ?? '')
  const save = useMutation({
    mutationFn: async () => {
      const rows = unwrap(await supabase.from('location_photos').update({ caption: caption.trim() || null, comment: comment.trim() || null }).eq('id', photo.id).select('id'))
      if (!rows?.length) throw new Error('Изменить подпись может автор загрузки или руководитель')
    },
    onSuccess: () => { toast.success('Подпись сохранена'); qc.invalidateQueries({ queryKey: clientKeys(photo.location_id).photos }); onClose() },
    onError: (e) => toast.error(e),
  })
  return (
    <Modal open onClose={onClose} title="Фото" size="lg"
      footer={<>
        {canDelete && <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={onDelete} className="mr-auto">Удалить</Button>}
        <Button onClick={onClose}>Закрыть</Button>
        {canEdit && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Сохранить подпись</Button>}
      </>}>
      <div className="space-y-3">
        {url && <img src={url} alt={photo.caption ?? ''} className="max-h-[60vh] w-full rounded object-contain" />}
        <p className="text-xs text-slate-500">Загрузил: {author} · {fmtDateTime(photo.created_at)}</p>
        <Field label="Подпись">{(id) => <Input id={id} value={caption} onChange={(e) => setCaption(e.target.value)} disabled={!canEdit} maxLength={200} />}</Field>
        <Field label="Комментарий">{(id) => <Textarea id={id} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} disabled={!canEdit} maxLength={1000} />}</Field>
      </div>
    </Modal>
  )
}
