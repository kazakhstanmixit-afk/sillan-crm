import { describe, expect, it } from 'vitest'
import { detectPlatform, twoGisAppUrl } from '../open2gis'
import { mapHref } from '../format'

describe('ссылки 2GIS открываются в приложении', () => {
  const route = mapHref({ lat: 51.1, lng: 71.4, city: 'Астана', externalId: '70000001066981028' })!
  it('маршрут до точки', () => {
    expect(twoGisAppUrl(route, 'ios')).toBe('dgis://2gis.ru/routeSearch/rsType/car/to/71.4,51.1')
    const a = twoGisAppUrl(route, 'android')!
    expect(a).toMatch(/^intent:\/\/2gis\.ru\/routeSearch\/rsType\/car\/to\/71\.4,51\.1#Intent;scheme=dgis;package=ru\.dublgis\.dgismobile;/)
    expect(decodeURIComponent(a.match(/browser_fallback_url=([^;]+)/)![1])).toBe(route)
  })
  it('карточка организации из источника', () => {
    expect(twoGisAppUrl('https://2gis.kz/astana/firm/70000001066981028', 'ios')).toBe('dgis://2gis.ru/firm/70000001066981028')
  })
  it('на компьютере и для чужих ссылок — без изменений', () => {
    expect(twoGisAppUrl(route, 'desktop')).toBeNull()
    expect(twoGisAppUrl('https://example.com/firm/123456789', 'android')).toBeNull()
    expect(twoGisAppUrl('https://2gis.kz/astana', 'android')).toBeNull()
  })
  it('платформа', () => {
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14)')).toBe('android')
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('ios')
    expect(detectPlatform('Mozilla/5.0 (Macintosh)', 5)).toBe('ios')
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe('desktop')
  })
})
