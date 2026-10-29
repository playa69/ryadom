import { describe, expect, it } from 'vitest'
import { accountKindOf, formOutcomeFromCode, formOutcomeFromStatus } from '../src/events'
import {
  isDeniedKey,
  normalizePath,
  roundedToHour,
  sanitizeProperties,
  sanitizeUrl,
  scrubElementsChain,
  scrubEvent,
} from '../src/sanitize'

describe('исходы форм и вид аккаунта (общие для всех клиентов)', () => {
  it('статус ответа: лимит, проверка сервера, отказ, ошибка', () => {
    expect(formOutcomeFromStatus(429)).toBe('rate_limited')
    expect(formOutcomeFromStatus(422)).toBe('invalid')
    expect(formOutcomeFromStatus(401)).toBe('rejected')
    expect(formOutcomeFromStatus(403)).toBe('rejected')
    expect(formOutcomeFromStatus(409)).toBe('rejected')
    expect(formOutcomeFromStatus(500)).toBe('error')
    expect(formOutcomeFromStatus(503)).toBe('error')
    expect(formOutcomeFromStatus(0)).toBe('error')
  })

  it('400 это наш баг (клиент прислал непонятное), а не ошибка человека', () => {
    expect(formOutcomeFromStatus(400)).toBe('error')
  })

  it('код правила сервера: «слишком много попыток» это лимит, остальное отказ', () => {
    expect(formOutcomeFromCode('TOO_MANY_ATTEMPTS')).toBe('rate_limited')
    expect(formOutcomeFromCode('CODE_INVALID')).toBe('rejected')
    expect(formOutcomeFromCode('A_CODE_FROM_A_NEWER_SERVER')).toBe('rejected')
  })

  it('аккаунт без почты анонимный', () => {
    expect(accountKindOf({ email: null })).toBe('anonymous')
    expect(accountKindOf({ email: 'a@b.co' })).toBe('email')
  })

  it('аккаунт с Telegram без почты — telegram, почта важнее', () => {
    expect(accountKindOf({ email: null, telegramLinked: true })).toBe('telegram')
    expect(accountKindOf({ email: null, telegramLinked: false })).toBe('anonymous')
    expect(accountKindOf({ email: 'a@b.co', telegramLinked: true })).toBe('email')
  })
})

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

  it('тесты: балл, подшкалы, уровень, ответы и слова поиска не проходят под любым написанием ключа', () => {
    const clean = sanitizeProperties({
      test_id: 'phq9',
      found: false,
      from: 'tests',
      score: 20,
      Scores: [1, 2],
      subScores: 3,
      band: 'high',
      answers: [3, 3, 3],
      Answer: 2,
      query: 'тревога',
      search: 'тревога',
    })
    expect(clean).toEqual({ test_id: 'phq9', found: false, from: 'tests' })
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

  it('профиль человека ($set, $set_once) очищается так же, как событие: адреса, пути, id', () => {
    const event = {
      properties: {},
      $set_once: {
        $initial_current_url:
          'https://example.com/app/dialog/3f2a1c9e-5b7d-4e1a-9c3d-0a1b2c3d4e5f?utm_source=tg&secret=abc&fbclid=zzz#frag',
        $initial_referrer: 'https://www.google.com/search?q=как+справиться',
        $initial_pathname: '/dialog/3f2a1c9e-5b7d-4e1a-9c3d-0a1b2c3d4e5f',
        $initial_fbclid: 'zzz',
        $initial_browser: 'Chrome',
      },
      $set: {
        $current_url: 'https://example.com/app/reset-password?token=abc',
        $pathname: '/journal/123456',
        account_kind: 'email',
      },
    }
    const scrubbed = scrubEvent(event)!
    expect(scrubbed.$set_once).toEqual({
      $initial_current_url: 'https://example.com/app/dialog/:id?utm_source=tg',
      $initial_referrer: 'https://www.google.com/search',
      $initial_pathname: '/dialog/:id',
      $initial_browser: 'Chrome',
    })
    expect(scrubbed.$set).toEqual({
      $current_url: 'https://example.com/app/reset-password',
      $pathname: '/journal/:id',
      account_kind: 'email',
    })
  })

  it('$direct остаётся как есть', () => {
    const event = { properties: { $referrer: '$direct' } }
    expect(scrubEvent(event)!.properties.$referrer).toBe('$direct')
  })

  it('null проходит насквозь: событие уже отброшено', () => {
    expect(scrubEvent(null)).toBeNull()
  })
})

describe('клики: структура страницы без текста', () => {
  // The shape the SDK really sends: elements joined by ';', attributes sorted, quotes escaped.
  const CHAIN =
    'button.btn.px-4.md:flex:attr__aria-label="Написать Ане"attr__class="btn px-4 md:flex"attr__data-ph-capture="send"attr__href="/dialog/3f2a1c9e-5b7d-4e1a-9c3d-0a1b2c3d4e5f?token=abc"nth-child="2"nth-of-type="1"text="Привет, Аня; как дела?";' +
    'div.card-3f2a1c9e5b7d4e1a9c3d0a1b2c3d4e5f:attr__id="dialog-1234567"nth-child="1"nth-of-type="1"text="a \\"quoted\\" word";' +
    'body:nth-child="2"nth-of-type="1"'

  it('в цепочке остаются тег, классы, место в разметке и наш маркер; всё остальное режется', () => {
    expect(scrubElementsChain(CHAIN)).toBe(
      'button.btn.px-4.md:flex:attr__data-ph-capture="send"nth-child="2"nth-of-type="1";' +
        'div.:id:nth-child="1"nth-of-type="1";' +
        'body:nth-child="2"nth-of-type="1"',
    )
  })

  it('текст со знаком «;» и кавычками внутри не ломает разбор следующих элементов', () => {
    const tricky = 'a:nth-child="1"nth-of-type="1"text="x; b:nth-child=\\"9\\"";span:nth-child="3"nth-of-type="2"'
    expect(scrubElementsChain(tricky)).toBe('a:nth-child="1"nth-of-type="1";span:nth-child="3"nth-of-type="2"')
  })

  it('маркер с лишним в значении отбрасывается, номер позиции только цифрами', () => {
    expect(scrubElementsChain('a:attr__data-ph-capture="Привет, Аня"nth-child="x1"nth-of-type="1"')).toBe(
      'a:nth-of-type="1"',
    )
  })

  it('пустое и мусор не падают', () => {
    expect(scrubElementsChain('')).toBe('')
    expect(scrubElementsChain('"""; ;:::')).toBe('')
  })

  it('в событии автосбора нет текста элемента, ссылки, выделенного и скопированного', () => {
    const event = {
      properties: {
        $el_text: 'Привет, Аня',
        $selected_content: 'мне плохо',
        $copy_type: 'copy',
        $external_click_url: 'https://example.org/page?token=abc#x',
        $elements_chain: CHAIN,
        $event_type: 'click',
        $current_url: 'https://example.com/app/home?x=1',
      },
    }
    const props = scrubEvent(event)!.properties
    expect(props).not.toHaveProperty('$el_text')
    expect(props).not.toHaveProperty('$selected_content')
    expect(props).not.toHaveProperty('$copy_type')
    expect(props.$external_click_url).toBe('https://example.org')
    expect(props.$elements_chain).not.toMatch(/Аня|href|aria-label|token|1234567/)
    expect(props.$event_type).toBe('click')
    expect(props.$current_url).toBe('https://example.com/app/home')
  })

  it('массив $elements (мёртвые клики): остаются тег, классы, позиция и маркер', () => {
    const event = {
      properties: {
        $elements: [
          {
            tag_name: 'button',
            $el_text: 'Написать Ане',
            classes: ['btn', 'card-3f2a1c9e5b7d4e1a9c3d0a1b2c3d4e5f'],
            attr__class: 'btn',
            attr__href: '/x?token=abc',
            attr__id: 'dialog-1',
            'attr__aria-label': 'Написать Ане',
            'attr__data-ph-capture': 'send',
            nth_child: 2,
            nth_of_type: 1,
          },
          'not an element',
        ],
      },
    }
    expect(scrubEvent(event)!.properties.$elements).toEqual([
      { tag_name: 'button', classes: ['btn', ':id'], 'attr__data-ph-capture': 'send', nth_child: 2, nth_of_type: 1 },
      {},
    ])
  })
})

describe('веб-метрики', () => {
  it('остаются число и вердикт, без атрибуции (элемент и ресурс страницы)', () => {
    const event = {
      properties: {
        $web_vitals_LCP_value: 1200,
        $web_vitals_LCP_event: {
          name: 'LCP',
          value: 1200,
          rating: 'good',
          delta: 1200,
          id: 'v5-1-2',
          navigationType: 'navigate',
          attribution: { element: 'img.avatar#anna', url: 'https://example.com/avatars/anna.png?token=abc' },
          entries: [{}],
        },
        $web_vitals_CLS_event: 'unexpected',
      },
    }
    const props = scrubEvent(event)!.properties
    expect(props.$web_vitals_LCP_value).toBe(1200)
    expect(props.$web_vitals_LCP_event).toEqual({ name: 'LCP', value: 1200, rating: 'good', delta: 1200, navigationType: 'navigate' })
    expect(props).not.toHaveProperty('$web_vitals_CLS_event')
  })
})

describe('рекламные метки и значения кампаний (находки независимого ревью)', () => {
  it('click id уходят и из $session_entry_*, и те, что SDK знает, а мы не знали', () => {
    const event = {
      properties: {
        $session_entry_gclid: 'AAA',
        $session_entry_fbclid: 'BBB',
        qclid: 'Q1',
        oppref: 'O1',
        irclid: 'I1',
        _kx: 'K1',
        ph_keyword: 'как справиться с тревогой',
        $browser: 'Chrome',
      },
      $set_once: { $initial_qclid: 'Q1', $initial__kx: 'K1', $initial_browser: 'Chrome' },
    }
    const scrubbed = scrubEvent(event)!
    expect(scrubbed.properties).toEqual({ $browser: 'Chrome' })
    expect(scrubbed.$set_once).toEqual({ $initial_browser: 'Chrome' })
  })

  it('значение кампании только короткой меткой: ни почты, ни имени, ни фразы (в адресе и в свойствах)', () => {
    expect(
      sanitizeUrl('https://example.com/?utm_content=anna%40example.com&utm_term=Anna+Ivanova&utm_source=tg&ref=a b'),
    ).toBe('https://example.com/?utm_source=tg')
    const event = {
      properties: {
        utm_content: 'anna@example.com',
        utm_term: 'Anna Ivanova',
        utm_source: 'tg',
        $session_entry_utm_campaign: 'мне плохо',
        $initial_utm_medium: 'post',
      },
    }
    expect(scrubEvent(event)!.properties).toEqual({ utm_source: 'tg', $initial_utm_medium: 'post' })
  })

  it('внешняя ссылка: остаётся сайт, путь (профиль человека) и телефон уходят', () => {
    expect(scrubEvent({ properties: { $external_click_url: 'https://t.me/anna_ivanova?x=1' } })!.properties).toEqual({
      $external_click_url: 'https://t.me',
    })
    expect(scrubEvent({ properties: { $external_click_url: 'tel:84959895050' } })!.properties).toEqual({})
  })

  it('$set внутри свойств события чистится как профиль', () => {
    const event = { properties: { $set: { $current_url: 'https://example.com/reset?code=SECRET', email: 'a@b.co', ok: 1 } } }
    expect(scrubEvent(event)!.properties.$set).toEqual({ $current_url: 'https://example.com/reset', ok: 1 })
  })
})

describe('ошибки клиента', () => {
  const exception = {
    properties: {
      $exception_list: [
        {
          type: 'SyntaxError',
          value: 'Unexpected token \'П\', "Привет, мне сегодня тяжело, пишу тебе"... is not valid JSON at https://app.example/auth?code=SECRET',
          mechanism: { type: 'onerror', handled: false, synthetic: false, extra: 'x' },
          stacktrace: {
            type: 'raw',
            frames: [
              {
                filename: 'https://app.example/auth/reset-password?code=SECRET123&email=anna%40example.com#x',
                abs_path: 'https://app.example/_next/static/chunks/app.js?v=1',
                function: 'parse',
                lineno: 10,
                colno: 5,
                in_app: true,
                context_line: 'const secret = "Привет"',
              },
            ],
          },
        },
      ],
      $exception_message: 'Cannot read "Анна" of undefined, mail anna@example.com',
      $exception_source: 'https://app.example/auth?code=SECRET',
    },
  }

  it('в ошибке остаются вид, обезличенный текст, способ перехвата и кадры без адресов с секретами', () => {
    const props = scrubEvent(structuredClone(exception))!.properties as Record<string, unknown>
    const text = JSON.stringify(props)
    expect(text).not.toMatch(/SECRET|Привет|anna|Анна|context_line|extra/)
    const item = (props.$exception_list as Array<Record<string, any>>)[0]!
    expect(item.type).toBe('SyntaxError')
    expect(item.value).toContain('Unexpected token')
    expect(item.value.length).toBeLessThanOrEqual(80)
    expect(item.mechanism).toEqual({ type: 'onerror', handled: false, synthetic: false })
    expect(item.stacktrace.frames[0]).toMatchObject({
      filename: 'https://app.example/auth/reset-password',
      function: 'parse',
      lineno: 10,
      colno: 5,
      in_app: true,
    })
    expect(props.$exception_source).toBe('https://app.example/auth')
  })

  it('не падает на мусоре вместо списка ошибок', () => {
    expect(() => scrubEvent({ properties: { $exception_list: 'x', $exception_message: 5 as never } })).not.toThrow()
    expect(scrubEvent({ properties: { $exception_list: [null, 3, { value: 7 }] } })!.properties.$exception_list).toEqual([{}, {}, {}])
  })
})

describe('цепочка элементов: двусмысленное экранирование (находки независимого ревью)', () => {
  it('значение, оканчивающееся на «\\», ломает разбор: цепочка не сохраняется целиком', () => {
    const chain =
      'a:attr__title="C:\\"nth-child="1"nth-of-type="1";li:attr__aria-label="Hi;Anna Ivanova"nth-child="2"nth-of-type="1"'
    expect(scrubElementsChain(chain)).toBe('')
  })

  it('элемент без атрибутов не сохраняется: имя тега из середины текста не просачивается', () => {
    expect(scrubElementsChain('Anna:')).toBe('')
    expect(scrubElementsChain('div:nth-child="1"nth-of-type="1";Anna Ivanova')).toBe('div:nth-child="1"nth-of-type="1"')
  })

  it('обычная экранированная кавычка в тексте цепочку не ломает', () => {
    expect(scrubElementsChain('a:nth-child="1"nth-of-type="1"text="say \\"hi\\"";p:nth-child="2"nth-of-type="1"')).toBe(
      'a:nth-child="1"nth-of-type="1";p:nth-child="2"nth-of-type="1"',
    )
  })
})

describe('sanitizeProperties на длинной строке', () => {
  it('сначала обрезает, потом проверяет: сто тысяч знаков без пробелов не вешают поток', () => {
    const started = Date.now()
    const clean = sanitizeProperties({ blob: 'a'.repeat(100_000) })
    expect(Date.now() - started).toBeLessThan(200)
    expect(String(clean.blob)).toHaveLength(120)
  })
})

describe('экран линий помощи', () => {
  it('визит на «Люди рядом» не отправляется вовсе, под любым базовым путём', () => {
    for (const pathname of ['/app/people', '/pwa/people/', '/people']) {
      expect(scrubEvent({ properties: { $pathname: pathname, $current_url: `https://example.com${pathname}` } })).toBeNull()
    }
  })

  it('другие экраны и похожие имена не затронуты', () => {
    for (const pathname of ['/app/home', '/app/people-search', '/app/peoples', '/app/journal/people-x']) {
      expect(scrubEvent({ properties: { $pathname: pathname } })).not.toBeNull()
    }
  })
})

describe('roundedToHour', () => {
  it('начало часа, минуты и секунды обнуляются', () => {
    expect(roundedToHour(new Date('2026-10-10T14:37:23.456Z')).toISOString()).toBe('2026-10-10T14:00:00.000Z')
    expect(roundedToHour(new Date('2026-10-10T14:00:00.000Z')).toISOString()).toBe('2026-10-10T14:00:00.000Z')
  })
})
