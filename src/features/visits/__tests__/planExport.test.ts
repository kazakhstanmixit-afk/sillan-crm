import { describe, expect, it } from 'vitest'
import { groupPlan, weekStart, type PlanExportRow } from '../planExport'

const row = (manager_id: string, name: string, planned_date: string, position: number): PlanExportRow => ({
  manager_id, planned_date, position, status: 'planned', manager: { full_name: name },
  location: { name: 'Точка', confirmed_address: null, source_address: 'улица, 1', city: 'Астана', phones: [], source_category: 'Шиномонтаж' },
})

describe('выгрузка плана в Excel', () => {
  it('неделя начинается с понедельника', () => {
    expect(weekStart('2026-11-24')).toBe('2026-11-23')
    expect(weekStart('2026-11-23')).toBe('2026-11-23')
    expect(weekStart('2026-11-29')).toBe('2026-11-23')
  })
  it('точки группируются по торговым, по алфавиту', () => {
    const g = groupPlan([row('b', 'Нұрсипат', '2026-11-24', 1), row('a', 'Алишер', '2026-11-24', 1), row('b', 'Нұрсипат', '2026-11-25', 1)])
    expect(g.map((x) => x.name)).toEqual(['Алишер', 'Нұрсипат'])
    expect(g[1].rows).toHaveLength(2)
  })
})
