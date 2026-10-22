// Расстояния по прямой (без учёта дорог и мостов) и примерный порядок объезда точек.

export interface GeoPoint { lat: number; lng: number }

/** Расстояние по прямой, км (формула гаверсинусов) */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export const hasCoords = (p: { lat: number | null; lng: number | null } | null | undefined): p is GeoPoint =>
  !!p && p.lat !== null && p.lng !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng)

const pathLength = (pts: GeoPoint[], order: number[]) => order.slice(1).reduce((s, idx, i) => s + distanceKm(pts[order[i]], pts[idx]), 0)

/**
 * Примерный порядок объезда, начиная с точки start: ближайший сосед, затем улучшение 2-opt
 * (убирает «перехлёсты» маршрута). Возвращает индексы точек. Маршрут открытый — без возврата в начало.
 */
export function orderByDistance(pts: GeoPoint[], start = 0): number[] {
  const n = pts.length
  if (n <= 2) return pts.map((_, i) => i)
  const left = new Set(pts.map((_, i) => i))
  const order = [start]
  left.delete(start)
  while (left.size) {
    const last = pts[order[order.length - 1]]
    let best = -1
    let bestD = Infinity
    for (const i of left) {
      const d = distanceKm(last, pts[i])
      if (d < bestD) { bestD = d; best = i }
    }
    order.push(best)
    left.delete(best)
  }
  // 2-opt: переворачиваем участки, пока маршрут становится короче (первая точка остаётся стартом)
  let improved = true
  for (let guard = 0; improved && guard < 200; guard++) {
    improved = false
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const a = pts[order[i - 1]], b = pts[order[i]], c = pts[order[k]], d = k + 1 < n ? pts[order[k + 1]] : null
        const before = distanceKm(a, b) + (d ? distanceKm(c, d) : 0)
        const after = distanceKm(a, c) + (d ? distanceKm(b, d) : 0)
        if (after + 1e-9 < before) {
          order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse())
          improved = true
        }
      }
    }
  }
  return order
}

export function routeKm(pts: GeoPoint[]): number {
  return pathLength(pts, pts.map((_, i) => i))
}

export const fmtKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(km < 10 ? 1 : 0)} км`)
