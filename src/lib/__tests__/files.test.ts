import { describe, expect, it } from 'vitest'
import { IMAGE_TYPES, normalizeFileType, validateFile } from '../files'

describe('тип файла перед загрузкой', () => {
  it('пустой тип и image/jpg приводятся к image/jpeg', () => {
    expect(normalizeFileType(new File(['x'], 'IMG_1.JPG', { type: '' })).type).toBe('image/jpeg')
    expect(normalizeFileType(new File(['x'], 'photo.jpg', { type: 'image/jpg' })).type).toBe('image/jpeg')
    expect(normalizeFileType(new File(['x'], 'scan.heic', { type: '' })).type).toBe('image/heic')
    expect(validateFile(normalizeFileType(new File(['x'], 'a.jfif', { type: '' })), IMAGE_TYPES)).toBeNull()
  })
  it('неподходящие файлы отклоняются понятно', () => {
    expect(validateFile(new File(['x'], 'virus.exe', { type: 'application/x-msdownload' }), IMAGE_TYPES)).toContain('недопустимый тип')
  })
})
