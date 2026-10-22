import { Input, Select } from '@/components/ui'
import { usePerms } from '@/auth/AuthProvider'
import { useDicts } from '@/lib/dictionaries'
import { toISODate, todayISO } from '@/lib/format'

export interface PeriodState { from: string; to: string; manager: string; city: string; direction: string }

const presets: { label: string; range: () => [string, string] }[] = [
  { label: 'Сегодня', range: () => [todayISO(), todayISO()] },
  { label: '7 дней', range: () => [todayISO(-6), todayISO()] },
  { label: 'Этот месяц', range: () => { const d = new Date(); return [toISODate(new Date(d.getFullYear(), d.getMonth(), 1)), todayISO()] } },
  { label: 'Прошлый месяц', range: () => { const d = new Date(); return [toISODate(new Date(d.getFullYear(), d.getMonth() - 1, 1)), toISODate(new Date(d.getFullYear(), d.getMonth(), 0))] } },
  { label: 'Квартал', range: () => { const d = new Date(); const q = Math.floor(d.getMonth() / 3) * 3; return [toISODate(new Date(d.getFullYear(), q, 1)), todayISO()] } },
  { label: 'Год', range: () => [`${new Date().getFullYear()}-01-01`, todayISO()] },
]

export function PeriodFilters({ value, onChange, cities }: { value: PeriodState; onChange: (v: PeriodState) => void; cities: string[] }) {
  const d = useDicts()
  const perms = usePerms()
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => {
          const [f, t] = p.range()
          const active = value.from === f && value.to === t
          return (
            <button key={p.label} onClick={() => onChange({ ...value, from: f, to: t })} className={`rounded-md border px-2.5 py-1.5 text-[13px] ${active ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              {p.label}
            </button>
          )
        })}
      </div>
      <label className="text-xs text-slate-500">С<Input type="date" value={value.from} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} className="h-8 w-auto" /></label>
      <label className="text-xs text-slate-500">По<Input type="date" value={value.to} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} className="h-8 w-auto" /></label>
      {perms.view_team && (
        <Select className="h-8 w-auto" value={value.manager} onChange={(e) => onChange({ ...value, manager: e.target.value })} aria-label="Менеджер">
          <option value="">Все менеджеры</option>
          {d.managers.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
        </Select>
      )}
      <Select className="h-8 w-auto" value={value.city} onChange={(e) => onChange({ ...value, city: e.target.value })} aria-label="Город">
        <option value="">Все города</option>
        {cities.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
      <Select className="h-8 w-auto" value={value.direction} onChange={(e) => onChange({ ...value, direction: e.target.value })} aria-label="Направление">
        <option value="">Все направления</option>
        {d.activeDirections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </Select>
    </div>
  )
}
