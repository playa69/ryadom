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
    steps: ['Нажми на значок слева от адреса (замок или «настройки»)', 'Выбери «Разрешения» и включи «Микрофон»', 'настройки телефона → «Приложения» → Chrome'],
  },
  {
    key: 'safari-ios',
    title: 'Safari на iPhone',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    standalone: false,
    steps: ['Нажми «Аа» в левой части адресной строки', 'Выбери «Настройки веб-сайта»', 'Поставь «Микрофон» → «Разрешить»'],
  },
  {
    key: 'chrome-ios',
    title: 'Chrome на iPhone',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
    standalone: false,
    steps: ['Открой «Настройки» на iPhone и найди в списке Chrome', 'Включи переключатель «Микрофон»'],
  },
  {
    key: 'yandex-android',
    title: 'Яндекс Браузер на Android',
    userAgent:
      'Mozilla/5.0 (Linux; arm_64; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0 Mobile Safari/537.36',
    standalone: false,
    steps: ['Нажми на значок слева от адреса', 'Открой «Настройки сайта» → «Микрофон»'],
  },
  {
    key: 'samsung',
    title: 'Samsung Internet',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    standalone: false,
    steps: ['Нажми на значок замка слева от адреса', 'Открой «Разрешения» и включи «Микрофон»'],
  },
  {
    key: 'firefox-android',
    title: 'Firefox на Android',
    userAgent:
      'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
    standalone: false,
    steps: ['Выбери «Изменить разрешения сайта»'],
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
    key: 'pwa-android',
    title: 'установленное PWA на Android',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    standalone: true,
    steps: ['Открой настройки телефона → «Приложения» → Рядом', 'Выбери «Разрешения» → «Микрофон»'],
  },
  {
    key: 'chrome-desktop',
    title: 'Chrome на компьютере',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    standalone: false,
    steps: ['Нажми на значок слева от адреса', 'Если браузер предложит перезагрузить страницу — перезагрузи'],
  },
  {
    key: 'safari-mac',
    title: 'Safari на Mac',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    standalone: false,
    steps: ['В меню выбери Safari → «Настройки для этого веб-сайта»'],
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
