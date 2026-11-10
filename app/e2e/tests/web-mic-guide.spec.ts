import { openWebApp, registerAndConfirm, uniqueEmail } from '../support/web'
import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { step } from '../support/evidence'

/**
 * `openspec/changes/add-mic-permission-guide`, «Микрофон или голос недоступны»: after a refused microphone the
 * person gets the steps for the place the page is open in; an automatic start only falls back to text.
 */
const PLACES = [
  {
    key: 'chrome-android',
    title: 'Chrome на Android',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    standalone: false,
    steps: ['Нажми на замок слева от адреса', 'Выбери «Разрешения»', 'Включи «Микрофон»'],
  },
  {
    key: 'safari-ios',
    title: 'Safari на iPhone',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    standalone: false,
    steps: ['Нажми «Аа» в адресной строке', 'Выбери «Настройки веб-сайта»', 'Поставь «Микрофон» → «Разрешить»'],
  },
  {
    key: 'yandex',
    title: 'Яндекс Браузер',
    userAgent:
      'Mozilla/5.0 (Linux; arm_64; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0 Mobile Safari/537.36',
    standalone: false,
    steps: ['Нажми на значок слева от адреса', 'Открой «Настройки сайта»', 'Поставь «Микрофон» → «Разрешить»'],
  },
  {
    key: 'embedded',
    title: 'встроенное окно приложения Яндекса',
    userAgent:
      'Mozilla/5.0 (Linux; arm_64; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaSearchApp/24.80 Mobile Safari/537.36',
    standalone: false,
    steps: ['Скопируй адрес — кнопка ниже', 'Открой Chrome или Safari и вставь адрес в строку'],
  },
  {
    key: 'pwa',
    title: 'установленное PWA',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    standalone: true,
    steps: [
      'Открой настройки телефона → «Приложения» → Рядом',
      'Выбери «Разрешения» → «Микрофон»',
      'Вернись и нажми «Попробовать снова»',
    ],
  },
]

for (const place of PLACES) {
  test.describe(place.key, () => {
    test.use({ userAgent: place.userAgent })

    test(`микрофон не разрешён: ${place.title} — окно с инструкцией`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.addInitScript((standalone) => {
        const denied = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: denied, configurable: true })
        if (standalone) {
          const native = window.matchMedia.bind(window)
          window.matchMedia = (query: string) =>
            query.includes('display-mode: standalone')
              ? ({ ...native(query), matches: true } as MediaQueryList)
              : native(query)
        }
      }, place.standalone)
      await clearMailbox()
      await openWebApp(page)
      await registerAndConfirm(page, uniqueEmail('web-mic-guide'))

      // The start from home is automatic: no window, the screen falls back to text with a notice.
      await page.getByTestId('home-mic').click()
      await expect(page).toHaveURL(/\/dialog\/[^/]+$/)
      await expect(page.getByTestId('mic-guide-steps')).toHaveCount(0)
      await step(page, `${place.key}-auto-fallback`, 'Автостарт без разрешения: текстовый вид, окна нет')

      // The person presses the microphone themself: the guide for this place.
      await page.getByRole('button', { name: /Голос|Говорить|микрофон/i }).first().click()
      const steps = page.getByTestId('mic-guide-steps')
      await expect(steps).toBeVisible()
      for (const text of place.steps) await expect(steps).toContainText(text)
      await step(page, `${place.key}-guide`, `Окно с инструкцией: ${place.title}`)

      // «Писать текстом» closes the window and leaves the text view.
      await page.getByTestId('mic-guide-text').click()
      await expect(steps).toHaveCount(0)
    })
  })
}
