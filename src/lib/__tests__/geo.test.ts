import { describe, expect, it } from 'vitest'
import { distanceKm, orderByDistance, routeKm } from '../geo'

// Астана: левый берег (Коргалжын, Туран, Мухамедханова) и правый берег (Акжол, Жансугурова)
const pts = [
  { name: 'Jaguar, Коргалжын 7а', lat: 51.1215, lng: 71.3683 },
  { name: 'VN Service, Акжол 52/1', lat: 51.1478, lng: 71.5225 },
  { name: 'Тойота, Туран 76', lat: 51.1057, lng: 71.4055 },
  { name: 'Hyundai, Мухамедханова 14', lat: 51.1110, lng: 71.4170 },
  { name: 'Changan, Жансугурова 3', lat: 51.1830, lng: 71.4510 },
]

describe('порядок объезда по координатам', () => {
  it('расстояние по прямой', () => {
    expect(distanceKm(pts[0], pts[1])).toBeGreaterThan(10)
    expect(distanceKm(pts[2], pts[3])).toBeLessThan(1.5)
  })
  it('сначала точки левого берега, потом правого — без скачков туда-обратно', () => {
    const order = orderByDistance(pts, 0)
    expect(order[0]).toBe(0)
    expect(order.slice(0, 3).sort()).toEqual([0, 2, 3])
    expect(order.slice(3).sort()).toEqual([1, 4])
    const before = routeKm(pts)
    const after = routeKm(order.map((i) => pts[i]))
    expect(after).toBeLessThan(before)
  })
  it('мало точек — порядок не меняется', () => {
    expect(orderByDistance(pts.slice(0, 2))).toEqual([0, 1])
  })
})
