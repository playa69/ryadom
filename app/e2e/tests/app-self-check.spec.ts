import { allTests } from '@ryadom/self-check/catalog'
import { openApp, openTab, startAnonymously } from '../support/app'
import { captureAnalytics, leaksOfTests } from '../support/analytics'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'

/**
 * Тесты внутри приложения, PWA (`REQ-WELL-06`…`REQ-WELL-08`, `openspec/specs/self-check`): блок «Самопроверка»
 * в «Дневнике», сегмент «Тесты» с поиском, прохождение в листе («Назад», «Прервать тест?»), результат без диагноза,
 * кризисный пункт PHQ-9 открывает экран помощи и лист SOS, тест проходится без сети; отчёты аналитики «список открыт»
 * и «поиск» уходят без баллов и слов запроса. Сохранение, история и профиль — во втором сценарии, предкэш service
 * worker — в третьем. Зеркало `web-self-check.spec.ts`.
 */
test('тесты в PWA: самопроверка, каталог, прохождение, результат, кризисный пункт, без сети', async ({ page, shot }) => {
  test.setTimeout(180_000)
  const analytics = await captureAnalytics(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')

  // ── блок «Самопроверка»: шесть шкал волны 1 ────────────────────────────
  const diary = page.locator('.page-current[data-name="diary"]')
  const block = diary.getByTestId('self-check-block')
  await expect(block).toBeVisible()
  await expect.poll(() => analytics.named('self_check_opened').map((p) => p.from)).toContain('diary')
  await expect(block).toContainText('Научные скрининговые опросники. Это не диагноз — только ориентир.')
  for (const id of ['gad7', 'phq9', 'rosenberg', 'wellbeing', 'stress', 'burnout']) {
    await expect(diary.getByTestId(`self-check-row-${id}`)).toBeAttached()
  }
  await expect(diary.getByTestId('self-check-row-gad7')).toContainText('GAD-7 · 7 вопросов · ~2 мин')
  await block.scrollIntoViewIfNeeded()
  await shot(page, 'app-self-check-block')

  // ── GAD-7: прогресс, ответ ведёт дальше, «Назад» хранит ответ ──────────
  await diary.getByTestId('self-check-start-gad7').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 1 из 7')
  await expect(page.getByTestId('test-back')).toHaveCount(0)
  await shot(page, 'app-self-check-question-1')
  await page.getByTestId('test-option-1').click()
  await page.getByTestId('test-option-2').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 3 из 7')
  await page.getByTestId('test-back').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 2 из 7')
  await expect(page.getByTestId('test-option-2')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'app-self-check-back')

  // ── «×» после трёх ответов спрашивает; «Продолжить» возвращает на тот же вопрос ──
  await page.getByTestId('test-option-2').click()
  await page.getByTestId('test-option-1').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 4 из 7')
  // The system "back" (the browser here, the hardware key on Android) asks the same as «×», it does not just close the sheet.
  await page.goBack()
  await expect(page.getByTestId('test-interrupt')).toContainText('Прервать тест?')
  await page.getByTestId('test-continue').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 4 из 7')
  await page.getByTestId('test-close').click()
  await expect(page.getByTestId('test-interrupt')).toContainText('Прервать тест?')
  await expect(page.getByTestId('test-interrupt')).toContainText('Ответы не сохранятся.')
  await shot(page, 'app-self-check-interrupt')
  await page.getByTestId('test-continue').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 4 из 7')

  // ── результат: 1+2+1+1+1+1+1 = 8 из 21, лёгкая выраженность ──────────────
  for (const v of [1, 1, 1, 1]) await page.getByTestId(`test-option-${v}`).click()
  await expect(page.getByTestId('test-result')).toBeVisible()
  await expect(page.getByTestId('result-score')).toContainText('8')
  await expect(page.getByTestId('result-score')).toContainText('/ 21')
  await expect(page.getByTestId('result-level')).toHaveText('лёгкая выраженность')
  await expect(page.getByTestId('test-result')).toContainText('Это скрининговый опросник, а не диагноз')
  await expect(page.getByTestId('result-retake')).toContainText('через 4 недели')
  await expect(page.getByTestId('result-specialist')).toHaveCount(0)
  await shot(page, 'app-self-check-result-mild')
  await page.getByTestId('result-close').click()
  await expect(page.getByTestId('test-result')).toBeHidden()

  // ── PHQ-9: пункт 9 → экран помощи после последнего вопроса, лист SOS, результат ──
  await diary.getByTestId('self-check-start-phq9').click()
  for (let i = 0; i < 8; i++) await page.getByTestId('test-option-3').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 9 из 9')
  await page.getByTestId('test-option-1').click()
  const crisis = page.getByTestId('test-crisis')
  await expect(crisis).toBeVisible()
  await expect(crisis).toContainText('Ты отметил(а), что бывают мысли о смерти')
  await expect(page.getByTestId('test-close')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(crisis).toBeVisible()
  // Nor can the system "back" close the help screen: the only ways out are its three buttons.
  await page.goBack()
  await expect(crisis).toBeVisible()
  await shot(page, 'app-self-check-crisis')
  await page.getByTestId('crisis-call').click()
  // The help sheet is above the test sheet: its lines are on screen, not hidden under it.
  const sos = page.locator('.sheet-modal.modal-in', { hasText: 'Если сейчас тяжело' })
  await expect(sos.getByText('Если сейчас тяжело')).toBeInViewport()
  await expect(sos.locator('.rd-hotline').first()).toBeInViewport()
  await shot(page, 'app-self-check-sos')
  await sos.getByText('Закрыть', { exact: true }).click()
  await expect(crisis).toBeVisible()
  await page.getByTestId('crisis-result').click()
  await expect(page.getByTestId('result-score')).toContainText('25')
  await expect(page.getByTestId('result-level')).toHaveText('сильная выраженность')
  await expect(page.getByTestId('result-specialist')).toContainText('Поговорить со специалистом')
  await expect(page.getByTestId('result-retake')).toContainText('через 2 недели')
  await shot(page, 'app-self-check-result-high')
  await page.getByTestId('result-close').click()

  // ── сегмент «Тесты»: каталог и поиск ────────────────────────────────────
  await diary.getByTestId('diary-segment-tests').click()
  const tests = page.locator('.page-current[data-name="diary"]')
  await expect(tests.getByTestId('tests-catalog')).toContainText('Это скрининг, а не диагноз')
  await expect(tests.getByTestId('tests-card-gad7')).toBeVisible()
  await expect.poll(() => analytics.named('self_check_opened').map((p) => p.from)).toContain('tests')
  await step(page, 'tests-opened', 'Сегмент «Тесты» открыт: все тесты списком; в аналитику ушло только «список открыт» с источником «Тесты»')
  await shot(page, 'app-self-check-catalog')
  await tests.getByTestId('tests-search').fill('трев')
  await expect(tests.getByTestId('tests-card-gad7')).toBeVisible()
  await expect(tests.getByTestId('tests-card-phq9')).toHaveCount(0)
  await shot(page, 'app-self-check-search')
  // Поиск считается, когда человек перестал печатать: одно событие на оставленный запрос, только «нашлось ли».
  await expect.poll(() => analytics.named('self_check_searched').map((p) => p.found)).toEqual([true])
  await step(page, 'search-found', 'Поиск «трев»: остались тесты про тревогу; в аналитику ушло только «нашлось», без слова')
  await tests.getByTestId('tests-search').fill('яхта')
  await expect(tests.getByTestId('tests-empty')).toBeVisible()
  await expect.poll(() => analytics.named('self_check_searched').map((p) => p.found)).toEqual([true, false])
  await step(page, 'search-empty', 'Поиск «яхта»: «Ничего не нашлось»; в аналитику ушло только «не нашлось», без слова')
  await tests.getByTestId('tests-search').fill('')

  // ── без сети: тест проходится, результат виден ─────────────────────────
  await page.context().setOffline(true)
  await tests.getByTestId('tests-start-rosenberg').click()
  for (let i = 0; i < 10; i++) await page.getByTestId('test-option-2').click()
  await expect(page.getByTestId('result-score')).toBeVisible()
  await shot(page, 'app-self-check-offline-result')
  await page.getByTestId('result-close').click()
  await page.context().setOffline(false)

  // ── аналитика: ни балла, ни уровня, ни ответа, ни слов поиска ───────────
  await expect.poll(() => analytics.named('self_check_completed').length).toBeGreaterThanOrEqual(3)
  expect(leaksOfTests(analytics.all(), ['трев', 'яхта'])).toEqual([])
  expect(analytics.named('self_check_searched')).toHaveLength(2)
})

/** One pass of a test: a tap per question. */
async function answerAll(page: import('@playwright/test').Page, values: number[]) {
  for (const v of values) await page.getByTestId(`test-option-${v}`).click()
}

/** The confirmation of Framework7 («ОК»). */
const confirmOk = (page: import('@playwright/test').Page) => page.locator('.dialog.modal-in .dialog-button', { hasText: 'ОК' }).click()

test('тесты в PWA: согласие, сохранение, история с графиком, удаление, ошибка красным тостом, профиль', async ({ page, shot }) => {
  test.setTimeout(240_000)
  const analytics = await captureAnalytics(page)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')
  const diary = page.locator('.page-current[data-name="diary"]')
  const toast = page.locator('.toast.modal-in')

  // ── первое сохранение: согласие, «Не сохранять» возвращает к результату ──
  await diary.getByTestId('self-check-start-gad7').click()
  await answerAll(page, [1, 2, 1, 1, 1, 1, 1])
  await expect(page.getByTestId('result-score')).toContainText('8')
  await page.getByTestId('result-save').click()
  const consent = page.getByTestId('test-consent')
  await expect(consent).toContainText('Сохранить результат?')
  await expect(consent).toContainText('Агент их не читает')
  await shot(page, 'app-self-check-consent')
  await page.getByTestId('consent-decline').click()
  await expect(page.getByTestId('test-result')).toBeVisible()

  // ── согласился: зелёный тост и строка в «Самопроверке» ────────────────
  await page.getByTestId('result-save').click()
  await page.getByTestId('consent-accept').click()
  await expect(toast.filter({ hasText: 'Результат сохранён' })).toHaveClass(/rd-toast--success/)
  await expect(page.getByTestId('test-result')).toBeHidden()
  await expect(diary.getByTestId('saved-line-gad7')).toContainText('8/21 — лёгкая выраженность')
  await shot(page, 'app-self-check-saved')

  // ── второй результат без листа согласия; экран теста: история и график ──
  await diary.getByTestId('self-check-start-gad7').click()
  await answerAll(page, [0, 0, 0, 0, 0, 0, 0])
  await page.getByTestId('result-save').click()
  await expect(diary.getByTestId('saved-line-gad7')).toContainText('0/21 — минимальная выраженность')
  await diary.getByTestId('self-check-history-gad7').click()
  await expect(page.getByTestId('history-row')).toHaveCount(2)
  await expect(page.getByTestId('history-chart-point')).toHaveCount(2)
  await expect.poll(() => analytics.named('self_check_opened').map((p) => p.from)).toContain('history')
  await shot(page, 'app-self-check-history')
  await page.getByTestId('history-delete').first().click()
  await expect(page.locator('.dialog.modal-in')).toContainText('исчезнет с сервера')
  await shot(page, 'app-self-check-delete-one')
  await confirmOk(page)
  await expect(page.getByTestId('history-row')).toHaveCount(1)
  await expect(page.getByTestId('history-chart-empty')).toBeVisible()
  await shot(page, 'app-self-check-history-one')
  await page.getByTestId('history-delete-test').click()
  await confirmOk(page)
  await expect(page.getByTestId('test-history')).toBeHidden()
  await expect(diary.getByTestId('saved-line-gad7')).toHaveCount(0)

  // ── ошибка сохранения — тот же тост, красный; результат остаётся ─────────
  await page.route('**/api/self-check/results', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()))
  await diary.getByTestId('self-check-start-gad7').click()
  await answerAll(page, [1, 1, 1, 1, 1, 1, 1])
  await page.getByTestId('result-save').click()
  await expect(toast.filter({ hasText: 'Не получилось сохранить' })).toHaveClass(/rd-toast--error/)
  await expect(page.getByTestId('test-result')).toBeVisible()
  await shot(page, 'app-self-check-save-error')
  await page.unroute('**/api/self-check/results')
  await page.getByTestId('result-save').click()
  await expect(diary.getByTestId('saved-line-gad7')).toContainText('7/21')

  // ── профиль → «Данные» ───────────────────────────────────────────────
  await openTab(page, 'Профиль')
  const profile = page.locator('.page-current[data-name="profile"]')
  await expect(profile.getByTestId('profile-data')).toBeVisible()
  await profile.getByTestId('profile-data').scrollIntoViewIfNeeded()
  await shot(page, 'app-self-check-profile-data')
  await profile.getByTestId('row-delete-self-check').click()
  await expect(page.locator('.dialog.modal-in')).toContainText('Исчезнут результаты всех тестов')
  await confirmOk(page)
  await expect(toast.filter({ hasText: 'Все результаты тестов удалены' })).toBeVisible()
  await step(page, 'profile-delete-all', 'Профиль → «Данные»: все результаты тестов удалены; клиент об этом не отчитывается, удаление считает сервер')
  await profile.getByTestId('row-revoke-self-check').click()
  await expect(page.locator('.dialog.modal-in')).toContainText('больше не будем их хранить')
  await shot(page, 'app-self-check-revoke')
  await confirmOk(page)
  await expect(profile.getByTestId('row-revoke-self-check')).toHaveCount(0)

  // ── аналитика: «Удалить все результаты тестов» клиент не отчитывает, удаление считает сервер ──
  // The next report after the deletion is the mark that everything before it has been sent.
  const startedBefore = analytics.named('self_check_started').length
  await openTab(page, 'Дневник')
  await diary.getByTestId('self-check-start-gad7').click()
  await expect.poll(() => analytics.named('self_check_started').length).toBe(startedBefore + 1)
  expect(analytics.named('self_check_result_action').filter((p) => p.test_id === 'all')).toEqual([])
  expect(leaksOfTests(analytics.all(), [])).toEqual([])
})

/**
 * Предкэш PWA: описания тестов вшиты в бандл, а бандл целиком лежит в предкэше service worker (`sw.ts`,
 * `__WB_MANIFEST`; исключены только posthog и декодер Opus). После первой загрузки воркер держит страницу, и после
 * перезагрузки без сети приложение поднимается из предкэша, а тест проходится до результата.
 */
test('тесты в PWA: описания в предкэше service worker, после перезагрузки без сети тест проходится', async ({ page }) => {
  test.setTimeout(180_000)
  await openApp(page)
  await startAnonymously(page)

  // ── воркер установлен, предкэш заполнен; каждое описание теста лежит в закэшированном файле ──
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  const described = allTests.flatMap((t) => [t.title, t.preface, ...t.items.map((i) => i.text)])
  const inPrecache = await page.evaluate(async (wanted) => {
    const scripts: string[] = []
    for (const name of (await caches.keys()).filter((n) => n.includes('precache'))) {
      const cache = await caches.open(name)
      for (const request of await cache.keys()) {
        if (!new URL(request.url).pathname.endsWith('.js')) continue
        const response = await cache.match(request)
        if (response) scripts.push(await response.text())
      }
    }
    return wanted.map((variants) => scripts.some((script) => variants.some((v) => script.includes(v))))
  }, described.map(variantsOf))
  expect(
    described.filter((_, i) => !inPrecache[i]),
    'тексты тестов, которых нет в предкэше',
  ).toEqual([])

  // ── первая перезагрузка с сетью: теперь страницей управляет воркер ──────
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)

  // ── без сети: страница и бандл берутся из предкэша, тест проходится до результата ──
  await page.context().setOffline(true)
  await page.reload()
  await openTab(page, 'Дневник')
  // Without the network the diary itself does not load, and the block «Самопроверка» comes with it; the catalog
  // needs no server and is what the segment «Тесты» shows.
  const diary = page.locator('.page-current[data-name="diary"]')
  await diary.getByTestId('diary-segment-tests').click()
  const tests = page.locator('.page-current[data-name="diary"]')
  await expect(tests.getByTestId('tests-card-k6')).toBeVisible()
  await step(page, 'precache-catalog', 'Страница перезагружена без сети, каталог тестов открыт из предкэша')
  await tests.getByTestId('tests-start-rosenberg').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 1 из 10')
  for (let i = 0; i < 10; i++) await page.getByTestId('test-option-2').click()
  await expect(page.getByTestId('result-score')).toBeVisible()
  await step(page, 'precache-result', 'Без сети тест пройден до результата, описание взято из предкэша')
  await page.getByTestId('result-close').click()
  await page.context().setOffline(false)
})

/** The text as the bundle may hold it: as it is, and with every non-ASCII letter written as a `\uXXXX` escape. */
function variantsOf(text: string): string[] {
  const escaped = text.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return escaped === text ? [text] : [text, escaped]
}
