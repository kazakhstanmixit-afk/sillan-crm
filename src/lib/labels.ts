export const ROLE_LABEL: Record<string, string> = {
  admin: 'Администратор',
  head: 'Руководитель',
  rep: 'Торговый представитель',
}

export const VISIT_STATUS_LABEL: Record<string, string> = {
  planned: 'Запланирован',
  done: 'Выполнен',
  rescheduled: 'Перенесён',
  cancelled: 'Отменён',
  failed: 'Не состоялся',
}
export const VISIT_STATUS_COLOR: Record<string, string> = {
  planned: 'blue', done: 'green', rescheduled: 'amber', cancelled: 'slate', failed: 'rose',
}

export const INTEREST_LABEL: Record<string, string> = {
  none: 'Нет интереса', low: 'Низкая', medium: 'Средняя', high: 'Высокая',
}

export const DECISION_ROLE_LABEL: Record<string, string> = {
  decision_maker: 'Принимает решение',
  influencer: 'Влияет на решение',
  user: 'Пользователь оборудования',
  other: 'Другое',
}

export const CHANNEL_LABEL: Record<string, string> = {
  phone: 'Звонок', whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'E-mail', visit: 'Личная встреча',
}

export const CONDITION_LABEL: Record<string, string> = {
  working: 'Исправно', worn: 'Изношено', needs_repair: 'Нужен ремонт', broken: 'Неисправно', unknown: 'Неизвестно',
}

export const NEED_LABEL: Record<string, string> = {
  none: 'Не требуется', replace: 'Замена', buy_more: 'Докупить', upgrade: 'Модернизация', repair: 'Ремонт',
}

export const COMMENT_KIND_LABEL: Record<string, string> = {
  comment: 'Комментарий',
  expansion: 'Будущее расширение',
  purchase_plan: 'Предполагаемая покупка',
  need: 'Выявленная потребность',
  agreement: 'Договорённость',
  next_step: 'Следующий шаг',
}

export const URGENCY_LABEL: Record<string, string> = {
  low: 'Низкая', normal: 'Обычная', high: 'Высокая', urgent: 'Срочно',
}
export const URGENCY_COLOR: Record<string, string> = {
  low: 'slate', normal: 'gray', high: 'amber', urgent: 'rose',
}

export const REQUEST_KIND_LABEL: Record<string, string> = {
  service: 'Сервис',
  parts: 'Запчасти',
  equipment: 'Продажа оборудования',
}

/** Полные названия отделов */
export const REQUEST_DEPT_LABEL: Record<string, string> = {
  service: 'Сервисный отдел',
  parts: 'Отдел запчастей',
  equipment: 'Отдел продаж (покупка оборудования)',
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: 'Вручную', '2gis': '2GIS', import: 'Импорт',
}
