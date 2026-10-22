import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { Badge, Button, Card, Checkbox, Field, Input, Modal, Select, useToast } from '@/components/ui'
import { usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { supabase } from '@/lib/supabase'
import { unwrap } from '@/lib/errors'

type FieldType = 'text' | 'number' | 'bool' | 'keywords' | 'direction' | 'kind' | 'color' | 'code'
interface Col { key: string; label: string; type: FieldType; required?: boolean; hint?: string }
interface DictConf { key: string; title: string; table: string; idKey: 'id' | 'code'; cols: Col[]; note?: string }

const COLORS = ['gray', 'slate', 'blue', 'green', 'amber', 'orange', 'rose', 'violet']

const DICTS: DictConf[] = [
  { key: 'directions', title: 'Направления деятельности', table: 'directions', idKey: 'id', note: 'Ключевые слова используются при импорте: если категория или название в файле содержит слово, точке присваивается направление.',
    cols: [{ key: 'name', label: 'Название', type: 'text', required: true }, { key: 'keywords', label: 'Ключевые слова для импорта', type: 'keywords', hint: 'Через запятую; достаточно начала слова: «шиномонтаж», «вулканизац»' }, { key: 'sort', label: 'Порядок', type: 'number' }, { key: 'is_active', label: 'Активно', type: 'bool' }] },
  { key: 'services', title: 'Услуги', table: 'services', idKey: 'id',
    cols: [{ key: 'name', label: 'Название', type: 'text', required: true }, { key: 'direction_id', label: 'Направление', type: 'direction' }, { key: 'sort', label: 'Порядок', type: 'number' }, { key: 'is_active', label: 'Активна', type: 'bool' }] },
  { key: 'categories', title: 'Категории оборудования', table: 'equipment_categories', idKey: 'id',
    cols: [{ key: 'name', label: 'Название', type: 'text', required: true }, { key: 'sort', label: 'Порядок', type: 'number' }, { key: 'is_active', label: 'Активна', type: 'bool' }] },
  { key: 'brands', title: 'Бренды оборудования', table: 'equipment_brands', idKey: 'id', note: 'Торговые представители могут добавлять новые бренды из карточки клиента.',
    cols: [{ key: 'name', label: 'Название', type: 'text', required: true }, { key: 'is_active', label: 'Активен', type: 'bool' }] },
  { key: 'clientStatuses', title: 'Статусы клиентов', table: 'client_statuses', idKey: 'code',
    cols: [{ key: 'code', label: 'Код', type: 'code', required: true }, { key: 'name', label: 'Название', type: 'text', required: true }, { key: 'color', label: 'Цвет', type: 'color' }, { key: 'sort', label: 'Порядок', type: 'number' }, { key: 'is_active', label: 'Активен', type: 'bool' }] },
  { key: 'requestStatuses', title: 'Статусы заявок', table: 'request_statuses', idKey: 'code', note: '«Итоговый» статус закрывает заявку (она уходит из открытых).',
    cols: [{ key: 'code', label: 'Код', type: 'code', required: true }, { key: 'name', label: 'Название', type: 'text', required: true }, { key: 'is_final', label: 'Итоговый', type: 'bool' }, { key: 'color', label: 'Цвет', type: 'color' }, { key: 'sort', label: 'Порядок', type: 'number' }, { key: 'is_active', label: 'Активен', type: 'bool' }] },
  { key: 'dealStages', title: 'Стадии сделок', table: 'deal_stages', idKey: 'code',
    cols: [{ key: 'code', label: 'Код', type: 'code', required: true }, { key: 'name', label: 'Название', type: 'text', required: true }, { key: 'kind', label: 'Тип', type: 'kind' }, { key: 'sort', label: 'Порядок', type: 'number' }, { key: 'is_active', label: 'Активна', type: 'bool' }] },
]
const KIND_LABEL: Record<string, string> = { open: 'Открытая', won: 'Выиграна', lost: 'Проиграна' }

type Row = Record<string, unknown>

export function DictionariesTab() {
  const perms = usePerms()
  const d = useDicts()
  const [active, setActive] = useState(DICTS[0].key)
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const conf = DICTS.find((x) => x.key === active)!
  const rows = (d as unknown as Record<string, Row[]>)[conf.key] ?? []
  const canEdit = perms.manage_dictionaries

  const display = (c: Col, r: Row) => {
    const v = r[c.key]
    if (c.type === 'bool') return v ? 'Да' : 'Нет'
    if (c.type === 'keywords') return (v as string[] | null)?.join(', ') || '—'
    if (c.type === 'direction') return v ? d.directionName(String(v)) : '—'
    if (c.type === 'kind') return KIND_LABEL[String(v)] ?? String(v)
    if (c.type === 'color') return <Badge color={String(v)}>{String(r.name)}</Badge>
    return v === null || v === undefined || v === '' ? '—' : String(v)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <nav className="flex gap-1 overflow-x-auto lg:flex-col">
        {DICTS.map((x) => (
          <button key={x.key} onClick={() => setActive(x.key)} className={`whitespace-nowrap rounded-md px-3 py-2 text-left text-sm ${active === x.key ? 'bg-brand-700 text-white' : 'text-slate-700 hover:bg-slate-100'}`}>{x.title}</button>
        ))}
      </nav>
      <Card title={conf.title} actions={canEdit && <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>Добавить</Button>} bodyClassName="p-0">
        {conf.note && <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">{conf.note}</p>}
        {!canEdit && <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">Справочники изменяет администратор.</p>}
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead><tr>{conf.cols.map((c) => <th key={c.key}>{c.label}</th>)}{canEdit && <th />}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r[conf.idKey])} className={r.is_active === false ? 'opacity-50' : ''}>
                  {conf.cols.map((c) => <td key={c.key} className={c.type === 'keywords' ? 'max-w-md text-xs' : ''}>{display(c, r)}</td>)}
                  {canEdit && <td><Button size="sm" variant="ghost" aria-label="Изменить" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(r)} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-slate-500">Элементы справочников не удаляются, чтобы не потерять историю, — отключите ненужные (снимите «Активно»).</p>
      </Card>
      {editing && <DictForm conf={conf} row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function DictForm({ conf, row, onClose }: { conf: DictConf; row: Row | null; onClose: () => void }) {
  const d = useDicts()
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState<Row>(() => {
    const init: Row = {}
    for (const c of conf.cols) {
      const cur = row?.[c.key]
      init[c.key] = c.type === 'keywords' ? ((cur as string[] | undefined) ?? []).join(', ') : c.type === 'bool' ? (cur ?? true) : (cur ?? (c.type === 'number' ? 100 : c.type === 'kind' ? 'open' : c.type === 'color' ? 'gray' : ''))
    }
    if (conf.idKey === 'code' && !row) { init.is_final = false }
    return init
  })
  const mut = useMutation({
    mutationFn: async () => {
      const payload: Row = {}
      for (const c of conf.cols) {
        if (c.type === 'code' && row) continue // код не меняется — на него ссылаются записи
        const val = v[c.key]
        if (c.type === 'keywords') payload[c.key] = String(val).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        else if (c.type === 'number') payload[c.key] = Number(val) || 0
        else if (c.type === 'direction') payload[c.key] = val || null
        else if (c.type === 'text' || c.type === 'code') payload[c.key] = String(val).trim()
        else payload[c.key] = val
        if (c.required && !payload[c.key]) throw new Error(`Заполните поле «${c.label}»`)
        if (c.type === 'code' && !/^[a-z][a-z0-9_]{1,30}$/.test(String(payload[c.key]))) throw new Error('Код: латиница в нижнем регистре, цифры и «_», например in_work')
      }
      const res = row
        ? await supabase.from(conf.table).update(payload).eq(conf.idKey, row[conf.idKey] as string).select(conf.idKey)
        : await supabase.from(conf.table).insert(payload).select(conf.idKey)
      if (!unwrap(res)?.length) throw new Error('Недостаточно прав')
    },
    onSuccess: () => { toast.success('Справочник обновлён'); qc.invalidateQueries({ queryKey: ['dicts'] }); onClose() },
    onError: (e) => toast.error(e),
  })
  return (
    <Modal open onClose={onClose} size="sm" title={row ? 'Изменить' : 'Добавить'} dismissable={!mut.isPending}
      footer={<><Button onClick={onClose} disabled={mut.isPending}>Отмена</Button><Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate()}>Сохранить</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); mut.mutate() }} className="space-y-3">
        {conf.cols.map((c) => {
          if (c.type === 'bool') return <Checkbox key={c.key} label={c.label} checked={Boolean(v[c.key])} onChange={(e) => setV({ ...v, [c.key]: e.target.checked })} />
          return (
            <Field key={c.key} label={c.label} required={c.required} hint={c.type === 'code' && row ? 'Код не меняется' : c.hint}>
              {(id) => c.type === 'direction' ? (
                <Select id={id} value={String(v[c.key] ?? '')} onChange={(e) => setV({ ...v, [c.key]: e.target.value })}><option value="">Без направления</option>{d.directions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
              ) : c.type === 'kind' ? (
                <Select id={id} value={String(v[c.key])} onChange={(e) => setV({ ...v, [c.key]: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              ) : c.type === 'color' ? (
                <Select id={id} value={String(v[c.key])} onChange={(e) => setV({ ...v, [c.key]: e.target.value })}>{COLORS.map((k) => <option key={k} value={k}>{k}</option>)}</Select>
              ) : (
                <Input id={id} type={c.type === 'number' ? 'number' : 'text'} value={String(v[c.key] ?? '')} disabled={c.type === 'code' && !!row} onChange={(e) => setV({ ...v, [c.key]: e.target.value })} />
              )}
            </Field>
          )
        })}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
