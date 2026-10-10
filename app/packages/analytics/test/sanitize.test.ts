import { describe, expect, it } from 'vitest'
import { isDeniedKey, normalizePath, sanitizeProperties, sanitizeUrl, scrubEvent } from '../src/sanitize'

describe('sanitizeProperties', () => {
  it('оставляет булевы, числа, короткие строки и массивы из них', () => {
    expect(sanitizeProperties({ resumed: true, count: 3, kind: 'email', fields: ['name', 'voice'] })).toEqual({
      resumed: true,
      count: 3,
      kind: 'email',
      fields: ['name', 'voice'],
    })
  })

  it('выбрасывает ключи, в которых живёт ПДн или свободный текст, как бы они ни были написаны', () => {
    const clean = sanitizeProperties({
      email: 'a@b.co',
      Password: 'x',
      refreshToken: 'x',
      user_name: 'Аня',
      takeaway: 'сегодня было тяжело',
      text: 'привет',
      phoneNumber: '+7',
      ok: 1,
    })
    expect(clean).toEqual({ ok: 1 })
  })

  it('выбрасывает значения, похожие на почту, даже под безобидным ключом', () => {
    expect(sanitizeProperties({ label: 'write me: ann@example.com', plain: 'hello' })).toEqual({ plain: 'hello' })
  })

  it('режет длинные строки и отбрасывает вложенные объекты, null и NaN', () => {
    const clean = sanitizeProperties({ long: 'x'.repeat(500), nested: { a: 1 }, nothing: null, bad: Number.NaN })
    expect(clean).toEqual({ long: 'x'.repeat(120) })
  })

  it('массив с недопустимым элементом отбрасывается целиком', () => {
    expect(sanitizeProperties({ list: ['a', { b: 1 }] as never })).toEqual({})
  })

  it('служебные поля PostHog с $ не считаются запрещёнными', () => {
    expect(sanitizeProperties({ $process_person_profile: false })).toEqual({ $process_person_profile: false })
  })

  it('isDeniedKey сравнивает без учёта регистра и разделителей', () => {
    expect(isDeniedKey('First_Name')).toBe(true)
    expect(isDeniedKey('device-key')).toBe(true)
    expect(isDeniedKey('policy_version')).toBe(false)
  })
})

describe('normalizePath', () => {
  it('заменяет идентификаторы и оставляет слова', () => {
    expect(normalizePath('/dialog/3f2a1c9e-5b7d-4e1a-9c3d-0a1b2c3d4e5f')).toBe('/dialog/:id')
    expect(normalizePath('/journal/123456')).toBe('/journal/:id')
    expect(normalizePath('/profile/sessions')).toBe('/profile/sessions')
    expect(normalizePath('/reset/aB3dE5gH7jK9mN1pQ3sT5u')).toBe('/reset/:id')
  })

  it('отрезает запрос и фрагмент', () => {
    expect(normalizePath('/reset-password?token=secret#x')).toBe('/reset-password')
  })

  it('корень остаётся корнем', () => {
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('')).toBe('/')
  })
})

describe('sanitizeUrl', () => {
  it('убирает секретный код из адреса сброса пароля', () => {
    expect(sanitizeUrl('https://example.com/app/reset-password?token=abc123&email=a@b.co#frag')).toBe(
      'https://example.com/app/reset-password',
    )
  })

  it('оставляет только метки кампаний', () => {
    expect(sanitizeUrl('https://example.com/?utm_source=tg&utm_medium=post&code=123456&x=1')).toBe(
      'https://example.com/?utm_source=tg&utm_medium=post',
    )
  })

  it('относительный путь остаётся путём', () => {
    expect(sanitizeUrl('/dialog/3f2a1c9e-5b7d-4e1a-9c3d-0a1b2c3d4e5f?x=1')).toBe('/dialog/:id')
  })

  it('схемы вроде capacitor: сохраняют источник', () => {
    expect(sanitizeUrl('capacitor://localhost/home?x=1')).toBe('capacitor://localhost/home')
  })

  it('не падает на мусоре и не пропускает из него запрос', () => {
    expect(() => sanitizeUrl('http://')).not.toThrow()
    expect(sanitizeUrl('http://?token=abc#frag')).not.toContain('token')
    expect(sanitizeUrl('not a url?code=123456')).not.toContain('123456')
  })
})

describe('scrubEvent', () => {
  it('чистит адреса в событии PostHog и свойства человека', () => {
    const event = {
      properties: {
        $current_url: 'https://example.com/app/reset-password?token=abc',
        $referrer: 'https://www.google.com/search?q=как+справиться',
        $pathname: '/dialog/3f2a1c9e-5b7d-4e1a-9c3d-0a1b2c3d4e5f',
        $browser: 'Chrome',
        custom: 'kept',
      },
      $set: { account_kind: 'email', email: 'a@b.co' },
    }
    const scrubbed = scrubEvent(event)!
    expect(scrubbed.properties.$current_url).toBe('https://example.com/app/reset-password')
    expect(scrubbed.properties.$referrer).toBe('https://www.google.com/search')
    expect(scrubbed.properties.$pathname).toBe('/dialog/:id')
    expect(scrubbed.properties.$browser).toBe('Chrome')
    expect(scrubbed.properties.custom).toBe('kept')
    expect(scrubbed.$set).toEqual({ account_kind: 'email' })
  })

  it('рекламные click id и заголовок страницы не уходят: SDK кладёт их в свойства сам', () => {
    const event = {
      properties: {
        gclid: 'abc',
        fbclid: 'def',
        yclid: '123',
        $initial_gclid: 'abc',
        title: 'Мой разговор про работу',
        utm_source: 'tg',
        $browser: 'Chrome',
      },
      $set_once: { $initial_fbclid: 'def', $initial_utm_source: 'tg' },
    }
    const scrubbed = scrubEvent(event)!
    expect(scrubbed.properties).toEqual({ utm_source: 'tg', $browser: 'Chrome' })
    expect(scrubbed.$set_once).toEqual({ $initial_utm_source: 'tg' })
  })

  it('$direct остаётся как есть', () => {
    const event = { properties: { $referrer: '$direct' } }
    expect(scrubEvent(event)!.properties.$referrer).toBe('$direct')
  })

  it('null проходит насквозь: событие уже отброшено', () => {
    expect(scrubEvent(null)).toBeNull()
  })
})
