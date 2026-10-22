import { useState } from 'react'
import { Input, Select } from '@/components/ui'
import { useDicts } from '@/lib/dictionaries'
import type { EquipmentBrand } from '@/lib/types'

/** Бренды: Sillan первым, «Другой» последним, остальные по алфавиту */
export function sortedBrands(brands: EquipmentBrand[]) {
  const rank = (n: string) => (n === 'Sillan' ? 0 : n === 'Другой' ? 2 : 1)
  return brands.filter((b) => b.is_active).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'ru'))
}

/** Бренд по названию (для заявок): выбор из справочника или ввод вручную */
export function BrandNameSelect({ id, value, onChange, placeholder = 'Не указан' }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const d = useDicts()
  const list = sortedBrands(d.brands)
  const known = !value || list.some((b) => b.name === value && b.name !== 'Другой')
  const [manual, setManual] = useState(!known)
  return (
    <div className="space-y-1.5">
      <Select id={id} value={manual ? '__other' : value} onChange={(e) => {
        if (e.target.value === '__other' || e.target.value === 'Другой') { setManual(true); onChange('') }
        else { setManual(false); onChange(e.target.value) }
      }}>
        <option value="">{placeholder}</option>
        {list.filter((b) => b.name !== 'Другой').map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
        <option value="__other">Другой — вписать</option>
      </Select>
      {manual && <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Название бренда" aria-label="Другой бренд" />}
    </div>
  )
}

/** Бренд по id (для оборудования на точке) */
export function BrandIdSelect({ value, onChange, className, ariaLabel }: { value: string; onChange: (v: string) => void; className?: string; ariaLabel?: string }) {
  const d = useDicts()
  return (
    <Select className={className} value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel ?? 'Бренд'}>
      <option value="">Бренд не знаю</option>
      {sortedBrands(d.brands).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </Select>
  )
}
