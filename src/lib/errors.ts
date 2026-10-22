/** Понятное сообщение об ошибке без технических подробностей и секретов. */
export function humanError(e: unknown): string {
  const err = e as { code?: string; message?: string; details?: string; name?: string } | null
  if (!err) return 'Неизвестная ошибка'
  const msg = String(err.message ?? '')
  if (err.name === 'TypeError' && /fetch|network/i.test(msg)) return 'Нет соединения с сервером. Проверьте интернет и повторите.'
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Нет соединения с сервером. Проверьте интернет и повторите.'
  switch (err.code) {
    case '42501':
      return /[а-яА-Я]/.test(msg) && !msg.includes('row-level') ? msg : 'Недостаточно прав для этого действия.'
    case '23505':
      if (msg.includes('client_request_id')) return 'Эта операция уже выполнена (повторная отправка).'
      if (msg.includes('bin')) return 'Компания с таким БИН уже есть в базе.'
      return 'Такая запись уже существует.'
    case '23503':
      return 'Запись связана с другими данными и не может быть изменена так.'
    case '23514':
      if (msg.includes('deals_lost_reason')) return 'Для проигранной сделки укажите причину проигрыша.'
      if (msg.includes('bin')) return 'БИН должен состоять из 12 цифр.'
      if (msg.includes('email')) return 'Проверьте адрес электронной почты.'
      if (msg.includes('contacts_something_known')) return 'Укажите хотя бы ФИО, телефон, WhatsApp или e-mail.'
      return 'Проверьте правильность заполнения полей.'
    case '22P02':
    case '22007':
    case '22008':
      return 'Неверный формат значения (число или дата).'
    case 'PGRST301':
    case '401':
      return 'Сессия истекла. Войдите снова.'
    case 'P0001':
      return msg
  }
  if (msg.includes('row-level security')) return 'Недостаточно прав для этого действия.'
  if (/JWT|token/i.test(msg)) return 'Сессия истекла. Войдите снова.'
  if (/[а-яА-Я]/.test(msg)) return msg
  return 'Не удалось выполнить операцию. Повторите попытку.'
}

/** Распаковать ответ Supabase: вернуть data или бросить ошибку. */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error
  return res.data as T
}
