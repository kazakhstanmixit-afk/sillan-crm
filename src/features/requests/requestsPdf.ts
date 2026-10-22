// Выгрузка выбранных заявок в один PDF: каждая заявка — на отдельной странице.
// pdfmake со встроенным шрифтом Roboto (поддерживает кириллицу) загружается только по нажатию кнопки.
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'
import { fmtDateTime, fmtMoney, todayISO } from '@/lib/format'
import { formatPhone } from '@/lib/phone'
import { REQUEST_DEPT_LABEL, URGENCY_LABEL } from '@/lib/labels'
import { KIND_TEXT } from './RequestFormModal'
import type { Request } from '@/lib/types'

type Full = Request & {
  location: { name: string; city: string | null; district: string | null; confirmed_address: string | null; source_address: string | null; phones: string[] } | null
  contact: { full_name: string | null; position: string | null; phone: string | null } | null
}

interface Names {
  status: (code: string) => string
  category: (id: string | null) => string
  person: (id: string | null) => string
}

export async function downloadRequestsPdf(ids: string[], names: Names) {
  const [reqRes, comRes] = await Promise.all([
    supabase.from('requests')
      .select('*, location:locations(name,city,district,confirmed_address,source_address,phones), contact:contacts(full_name,position,phone)')
      .in('id', ids).order('created_at'),
    supabase.from('request_comments').select('request_id, body, author_id, created_at').in('request_id', ids).order('created_at'),
  ])
  const rows = unwrap(reqRes) as Full[]
  const comments = unwrap(comRes) as { request_id: string; body: string; author_id: string | null; created_at: string }[]

  const pdfMakeMod = await import('pdfmake/build/pdfmake')
  const fontsMod = await import('pdfmake/build/vfs_fonts')
  const pdfMake = (pdfMakeMod.default ?? pdfMakeMod) as unknown as { vfs: unknown; createPdf: (d: unknown) => { download: (n: string) => void } }
  const f = (fontsMod.default ?? fontsMod) as unknown as { pdfMake?: { vfs: unknown }; vfs?: unknown }
  pdfMake.vfs = f.pdfMake?.vfs ?? f.vfs ?? f

  // в шрифте PDF нет знака «₸» — пишем «тг»
  const row = (label: string, value: string | number | null | undefined) =>
    [{ text: label, color: '#64748b' }, { text: value === null || value === undefined || value === '' ? '—' : String(value).replace(/₸/g, 'тг') }]

  const content = rows.flatMap((r, i) => {
    const loc = r.location
    const address = [loc?.city, loc?.district, loc?.confirmed_address ?? loc?.source_address].filter(Boolean).join(', ')
    const contact = r.contact ? [r.contact.full_name, r.contact.position, r.contact.phone && formatPhone(r.contact.phone)].filter(Boolean).join(', ') : ''
    const myComments = comments.filter((c) => c.request_id === r.id)
    return [
      { text: `Заявка ${r.number}`, style: 'h1', pageBreak: i ? 'before' : undefined },
      { text: `${REQUEST_DEPT_LABEL[r.kind]} · создана ${fmtDateTime(r.created_at)}`, color: '#64748b', margin: [0, 0, 0, 10] },
      {
        table: {
          widths: [150, '*'],
          body: [
            row('Статус', names.status(r.status_code)),
            row('Срочность', URGENCY_LABEL[r.urgency]),
            row('Клиент', loc?.name),
            row('Адрес', address),
            row('Телефон точки', loc?.phones?.map((p) => formatPhone(p)).join(', ')),
            row('Контактное лицо', contact),
            row(KIND_TEXT[r.kind].item, r.item_name),
            ...(r.kind !== 'parts' ? [row('Категория', r.category_id ? names.category(r.category_id) : '')] : []),
            row(r.kind === 'parts' ? 'Производитель' : 'Бренд', r.brand),
            r.kind !== 'parts' ? row('Модель', r.model) : row('Артикул', r.article),
            row('Количество', r.quantity),
            ...(r.kind === 'equipment' ? [row('Ориентировочный бюджет', r.budget ? fmtMoney(r.budget).replace('₸', 'тг') : '')] : []),
            row(KIND_TEXT[r.kind].desc, r.description),
            row('Комментарий', r.comment),
            row('Инициатор', names.person(r.initiator_id)),
            row('Ответственный в отделе', r.assignee_id ? names.person(r.assignee_id) : r.assignee_name),
          ],
        },
        layout: { hLineColor: () => '#e2e8f0', vLineColor: () => '#e2e8f0', paddingTop: () => 4, paddingBottom: () => 4 },
      },
      ...(myComments.length
        ? [
            { text: 'Комментарии', style: 'h2' },
            ...myComments.map((c) => ({ text: [{ text: `${fmtDateTime(c.created_at)} · ${names.person(c.author_id)}: `, color: '#64748b' }, c.body], margin: [0, 0, 0, 4] })),
          ]
        : []),
    ]
  })

  pdfMake.createPdf({
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.2 },
    styles: { h1: { fontSize: 16, bold: true }, h2: { fontSize: 12, bold: true, margin: [0, 14, 0, 6] } },
    footer: (page: number, pages: number) => ({ text: `Sillan CRM · стр. ${page} из ${pages}`, alignment: 'center', fontSize: 8, color: '#94a3b8' }),
    content,
  }).download(rows.length === 1 ? `zayavka_${rows[0].number}.pdf` : `zayavki_${todayISO()}.pdf`)
}
