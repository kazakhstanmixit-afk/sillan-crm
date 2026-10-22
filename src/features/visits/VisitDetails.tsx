import { Badge, InfoRow, Modal, Button } from '@/components/ui'
import { useDicts } from '@/lib/dictionaries'
import { fmtDate, fmtDateTime } from '@/lib/format'
import { INTEREST_LABEL, VISIT_STATUS_COLOR, VISIT_STATUS_LABEL } from '@/lib/labels'
import type { Visit } from '@/lib/types'

export function VisitDetails({ visit: v, locationName, onClose, onEdit }: { visit: Visit; locationName: string; onClose: () => void; onEdit?: () => void }) {
  const d = useDicts()
  return (
    <Modal open onClose={onClose} title={`Визит: ${locationName}`} size="lg"
      footer={<>{onEdit && <Button onClick={onEdit}>Изменить результат</Button>}<Button variant="primary" onClick={onClose}>Закрыть</Button></>}>
      <dl className="divide-y divide-slate-100">
        <InfoRow label="Статус"><Badge color={VISIT_STATUS_COLOR[v.status]}>{VISIT_STATUS_LABEL[v.status]}</Badge></InfoRow>
        <InfoRow label="Сотрудник">{d.profileName(v.manager_id)}</InfoRow>
        <InfoRow label="Плановая дата">{fmtDate(v.planned_date)}</InfoRow>
        <InfoRow label="Фактическое время">{v.actual_at ? fmtDateTime(v.actual_at) : null}</InfoRow>
        <InfoRow label="Цель">{v.purpose}</InfoRow>
        <InfoRow label="Результат">{v.result && <span className="whitespace-pre-line">{v.result}</span>}</InfoRow>
        <InfoRow label="С кем общался">{v.talked_to}</InfoRow>
        <InfoRow label="Услуги точки">{v.services_note}</InfoRow>
        <InfoRow label="Оборудование">{v.equipment_note}</InfoRow>
        <InfoRow label="Потребности">{v.needs}</InfoRow>
        <InfoRow label="Заинтересованность">{v.interest ? INTEREST_LABEL[v.interest] : null}</InfoRow>
        <InfoRow label="Договорённости">{v.agreements}</InfoRow>
        <InfoRow label="Возражения">{v.objections}</InfoRow>
        <InfoRow label="Следующий шаг">{v.next_step}</InfoRow>
        <InfoRow label="Повторный контакт">{v.follow_up_required ? `Да${v.next_contact_date ? `, ${fmtDate(v.next_contact_date)}` : ''}` : 'Нет'}</InfoRow>
        <InfoRow label="Комментарий">{v.comment}</InfoRow>
        {v.status_reason && <InfoRow label="Причина">{v.status_reason}</InfoRow>}
      </dl>
    </Modal>
  )
}
