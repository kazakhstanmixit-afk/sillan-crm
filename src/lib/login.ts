// Вход по логину: Supabase Auth требует e-mail, поэтому логин хранится как служебный адрес
// «логин@sillan.local». Писем на такие адреса не отправляется; пароль меняет администратор.
export const LOGIN_DOMAIN = 'sillan.local'

export const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/

/** Что ввёл пользователь (логин или e-mail) → адрес для Supabase Auth */
export function toAuthEmail(input: string): string {
  const v = input.trim().toLowerCase()
  return v.includes('@') ? v : `${v}@${LOGIN_DOMAIN}`
}

/** Как показывать учётную запись: логин без служебного домена или настоящий e-mail */
export function displayLogin(email: string | null | undefined): string {
  if (!email) return ''
  return email.endsWith('@' + LOGIN_DOMAIN) ? email.slice(0, -LOGIN_DOMAIN.length - 1) : email
}

export const isLoginAccount = (email: string | null | undefined) => !!email?.endsWith('@' + LOGIN_DOMAIN)
