// Ссылки на 2GIS на телефоне открываются сразу в приложении 2GIS (если оно установлено),
// иначе — сайт 2GIS как раньше. На компьютере ничего не меняется.

export type Platform = 'android' | 'ios' | 'desktop'

const ANDROID_PACKAGE = 'ru.dublgis.dgismobile'

export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && maxTouchPoints > 1)) return 'ios'
  return 'desktop'
}

/** Путь для приложения (без схемы): маршрут до точки, карточка организации или поиск. */
export function twoGisAppPath(href: string): string | null {
  let u: URL
  try { u = new URL(href) } catch { return null }
  if (!/(^|\.)2gis\.(kz|ru|com|kg|uz|ae)$/i.test(u.hostname)) return null
  const path = decodeURIComponent(u.pathname)
  const route = path.match(/\/directions\/points\/[^|]*\|(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (route) return `2gis.ru/routeSearch/rsType/car/to/${route[1]},${route[2]}`
  const firm = path.match(/\/firm\/(\d{6,})/)
  if (firm) return `2gis.ru/firm/${firm[1]}`
  const geo = path.match(/\/geo\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (geo) return `2gis.ru/geo/${geo[1]},${geo[2]}`
  const search = path.match(/\/search\/([^/]+)/)
  if (search) return `2gis.ru/search/${encodeURIComponent(search[1])}`
  return null
}

/** Ссылка, которую открыть вместо веб-адреса (null — оставить как есть). */
export function twoGisAppUrl(href: string, platform: Platform): string | null {
  if (platform === 'desktop') return null
  const p = twoGisAppPath(href)
  if (!p) return null
  if (platform === 'android') {
    // Chrome сам откроет сайт, если приложения нет
    return `intent://${p}#Intent;scheme=dgis;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(href)};end`
  }
  return `dgis://${p}`
}

/** Перехватывает нажатия на ссылки 2GIS по всему приложению. */
export function install2gisAppLinks() {
  if (typeof document === 'undefined') return
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  if (platform === 'desktop') return
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const app = twoGisAppUrl(a.href, platform)
    if (!app) return
    e.preventDefault()
    if (platform === 'ios') {
      // приложения нет — через 1,5 с открываем сайт
      const web = a.href
      const timer = window.setTimeout(() => { if (!document.hidden) window.location.href = web }, 1500)
      const cancel = () => { if (document.hidden) window.clearTimeout(timer) }
      document.addEventListener('visibilitychange', cancel, { once: true })
    }
    window.location.href = app
  }, true)
}
