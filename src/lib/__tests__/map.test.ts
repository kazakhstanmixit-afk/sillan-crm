import { describe, expect, it } from 'vitest'
import { mapHref } from '../format'

describe('кнопка «Карта» — 2GIS', () => {
  it('маршрут до организации, как в таблицах обхода', () => {
    expect(mapHref({ lat: 51.160154, lng: 71.431236, city: 'Астана', externalId: '70000001060675194' }))
      .toBe('https://2gis.kz/astana/directions/points/%7C71.431236%2C51.160154%3B70000001060675194')
  })
  it('без ID — маршрут до координат; без координат — карточка или поиск по адресу', () => {
    expect(mapHref({ lat: 43.23, lng: 76.94, city: 'Алматы' })).toBe('https://2gis.kz/almaty/directions/points/%7C76.94%2C43.23')
    expect(mapHref({ city: 'Астана', externalId: '70000001060675194' })).toBe('https://2gis.kz/astana/firm/70000001060675194')
    expect(mapHref({ city: 'Астана', address: 'ул. Сыганак, 2' })).toBe('https://2gis.kz/astana/search/%D0%90%D1%81%D1%82%D0%B0%D0%BD%D0%B0%2C%20%D1%83%D0%BB.%20%D0%A1%D1%8B%D0%B3%D0%B0%D0%BD%D0%B0%D0%BA%2C%202')
    expect(mapHref({})).toBeNull()
  })
})
