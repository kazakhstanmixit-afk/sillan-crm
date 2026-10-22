import { describe, expect, it } from 'vitest'
import { formatPhone, normPhone, searchPattern, splitPhones } from '../phone'

describe('телефоны', () => {
  it('приводит казахстанские номера к одному виду', () => {
    expect(normPhone('8 (701) 123-45-67')).toBe('77011234567')
    expect(normPhone('+7 701 123 45 67')).toBe('77011234567')
    expect(normPhone('7011234567')).toBe('77011234567')
    expect(normPhone('')).toBeNull()
  })
  it('форматирует для показа', () => {
    expect(formatPhone('87011234567')).toBe('+7 701 123 45 67')
    expect(formatPhone('12-34')).toBe('12-34')
  })
  it('разбивает строку с несколькими номерами (как в 2GIS)', () => {
    expect(splitPhones('+7 727 300-10-10, +7 701 111 22 33; 8(777)0000000')).toEqual(['+7 727 300-10-10', '+7 701 111 22 33', '8(777)0000000'])
    expect(splitPhones('доб. 12')).toEqual([])
  })
  it('поиск по телефону в любом формате', () => {
    expect(searchPattern('8 701 123-45-67')).toBe('77011234567')
    expect(searchPattern('123-45')).toBe('12345')
    expect(searchPattern('  Мотор ')).toBe('мотор')
  })
})
