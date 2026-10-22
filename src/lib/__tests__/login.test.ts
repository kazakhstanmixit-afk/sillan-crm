import { describe, expect, it } from 'vitest'
import { displayLogin, isLoginAccount, LOGIN_RE, toAuthEmail } from '../login'

describe('вход по логину', () => {
  it('логин превращается в служебный адрес, e-mail остаётся как есть', () => {
    expect(toAuthEmail(' Ivan.P ')).toBe('ivan.p@sillan.local')
    expect(toAuthEmail('Nina@Mail.kz')).toBe('nina@mail.kz')
  })
  it('показываем логин без служебного домена', () => {
    expect(displayLogin('ivan.p@sillan.local')).toBe('ivan.p')
    expect(displayLogin('nina@mail.kz')).toBe('nina@mail.kz')
    expect(isLoginAccount('ivan.p@sillan.local')).toBe(true)
  })
  it('допустимые логины', () => {
    expect(LOGIN_RE.test('erlan_t')).toBe(true)
    expect(LOGIN_RE.test('Ерлан')).toBe(false)
    expect(LOGIN_RE.test('a')).toBe(false)
  })
})
