import { supabase, FILES_BUCKET } from './supabase'

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
export const ATTACHMENT_TYPES = [
  ...IMAGE_TYPES, 'application/pdf', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/msword',
]

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf', csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
}

/**
 * Привести тип файла к стандартному: часть телефонов и Windows отдают пустой тип
 * или «image/jpg», а хранилище принимает только стандартные типы.
 */
export function normalizeFileType(f: File): File {
  const ext = (f.name.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase()
  const fixed = f.type === 'image/jpg' || f.type === 'image/pjpeg' ? 'image/jpeg' : f.type || EXT_TYPES[ext] || ''
  return fixed && fixed !== f.type ? new File([f], f.name, { type: fixed, lastModified: f.lastModified }) : f
}

export function validateFile(f: File, allowed: string[]): string | null {
  if (!allowed.includes(f.type)) return `«${f.name}»: недопустимый тип файла`
  if (f.size > MAX_FILE_BYTES) return `«${f.name}»: файл больше 10 МБ`
  return null
}

/** Уменьшить фото с телефона перед загрузкой (экономит мобильный трафик). HEIC загружается как есть. */
export async function compressImage(f: File, maxSide = 1920, quality = 0.85): Promise<File> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size < 600 * 1024) return f
  try {
    const bmp = await createImageBitmap(f)
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    if (scale === 1 && f.size < 2 * 1024 * 1024) return f
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality))
    if (!blob || blob.size >= f.size) return f
    return new File([blob], f.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return f // браузер не умеет декодировать формат — загружаем оригинал
  }
}

const extOf = (f: File) => (f.name.match(/\.(\w{2,5})$/)?.[1] ?? f.type.split('/')[1] ?? 'bin').toLowerCase()

/** Загрузить файл в приватное хранилище. Путь: <папка>/<id>/<uuid>.<ext> */
export async function uploadFile(folder: 'locations' | 'requests', ownerId: string, f: File) {
  const path = `${folder}/${ownerId}/${crypto.randomUUID()}.${extOf(f)}`
  const { error } = await supabase.storage.from(FILES_BUCKET).upload(path, f, { contentType: f.type, upsert: false })
  if (error) {
    const m = error.message || ''
    if (/row-level security|unauthorized|403/i.test(m)) throw new Error('Нет прав на загрузку в эту карточку (фото может добавлять ответственный за клиента или руководство)')
    if (/bucket not found/i.test(m)) throw new Error('В Supabase нет хранилища crm-files — проверьте, что миграции применены полностью')
    if (/mime|type/i.test(m)) throw new Error(`Хранилище не принимает тип файла ${f.type || '(неизвестный)'}`)
    if (/size|too large|413/i.test(m)) throw new Error('Файл больше 10 МБ')
    throw new Error(`Хранилище: ${m}`)
  }
  return path
}

export async function removeFile(path: string) {
  const { error } = await supabase.storage.from(FILES_BUCKET).remove([path])
  if (error) throw error
}

/** Временные ссылки на файлы (доступ проверяется политиками хранилища) */
export async function signedUrls(paths: string[], expiresIn = 3600): Promise<Record<string, string>> {
  if (!paths.length) return {}
  const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrls(paths, expiresIn)
  if (error) throw error
  return Object.fromEntries((data ?? []).filter((x) => x.signedUrl && x.path).map((x) => [x.path as string, x.signedUrl as string]))
}
