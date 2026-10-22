import { describe, expect, it } from 'vitest'
import { humanError } from '../errors'

describe('понятные сообщения об ошибках', () => {
  it('переводит коды Postgres и сетевые ошибки', () => {
    expect(humanError({ code: '42501', message: 'new row violates row-level security policy' })).toBe('Недостаточно прав для этого действия.')
    expect(humanError({ code: '23505', message: 'duplicate key value violates unique constraint "requests_client_request_id_key"' })).toContain('повторная отправка')
    expect(humanError({ code: '23514', message: 'violates check constraint "deals_lost_reason"' })).toContain('причину проигрыша')
    expect(humanError(new TypeError('Failed to fetch'))).toContain('Нет соединения')
    expect(humanError({ code: 'P0001', message: 'Укажите новую дату визита' })).toBe('Укажите новую дату визита')
    expect(humanError({ message: 'internal: connection string postgres://user:pass@host' })).toBe('Не удалось выполнить операцию. Повторите попытку.')
  })
})
