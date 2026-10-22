import { ArrowDown, ArrowUp } from 'lucide-react'
import { Button, Checkbox, Modal } from '@/components/ui'
import { CLIENT_COLUMNS, DEFAULT_VISIBLE, type ColumnPrefs } from './columns'

export function ColumnSettings({ open, onClose, prefs, onChange }: { open: boolean; onClose: () => void; prefs: ColumnPrefs; onChange: (p: ColumnPrefs) => void }) {
  const move = (i: number, d: -1 | 1) => {
    const order = [...prefs.order]
    const j = i + d
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    onChange({ ...prefs, order })
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Столбцы таблицы"
      size="sm"
      footer={
        <>
          <Button onClick={() => onChange({ order: CLIENT_COLUMNS.map((c) => c.key), hidden: CLIENT_COLUMNS.map((c) => c.key).filter((k) => !DEFAULT_VISIBLE.includes(k)) })}>
            По умолчанию
          </Button>
          <Button variant="primary" onClick={onClose}>Готово</Button>
        </>
      }
    >
      <ul className="divide-y divide-slate-100">
        {prefs.order.map((key, i) => {
          const col = CLIENT_COLUMNS.find((c) => c.key === key)!
          const visible = !prefs.hidden.includes(key)
          return (
            <li key={key} className="flex items-center justify-between py-1.5">
              <Checkbox
                label={col.label}
                checked={visible}
                disabled={key === 'name'}
                onChange={() => onChange({ ...prefs, hidden: visible ? [...prefs.hidden, key] : prefs.hidden.filter((h) => h !== key) })}
              />
              <span className="flex">
                <Button size="sm" variant="ghost" aria-label="Выше" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></Button>
                <Button size="sm" variant="ghost" aria-label="Ниже" disabled={i === prefs.order.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></Button>
              </span>
            </li>
          )
        })}
      </ul>
    </Modal>
  )
}
