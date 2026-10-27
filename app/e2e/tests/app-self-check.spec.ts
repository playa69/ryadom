import { openApp, openTab, startAnonymously } from '../support/app'
import { SELF_CHECK_ON } from '../support/flags'
import { expect, test } from '../support/fixtures'

/**
 * Тесты внутри приложения, PWA (`REQ-WELL-06`…`REQ-WELL-08`, `openspec/changes/add-self-check-tests`): блок «Самопроверка»
 * в «Дневнике», сегмент «Тесты» с поиском, прохождение в листе («Назад», «Прервать тест?»), результат без диагноза,
 * кризисный пункт PHQ-9 открывает экран помощи и лист SOS, тест проходится без сети. Сохранение и история появятся
 * с серверной частью (миграция 0010). Зеркало `web-self-check.spec.ts`.
 */
test.skip(!SELF_CHECK_ON, 'тесты выключены (E2E_SELF_CHECK=0): блока и сегмента нет, см. app-diary')

test('тесты в PWA: самопроверка, каталог, прохождение, результат, кризисный пункт, без сети', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await openApp(page)
  await startAnonymously(page)
  await openTab(page, 'Дневник')

  // ── блок «Самопроверка»: шесть шкал волны 1 ────────────────────────────
  const diary = page.locator('.page-current[data-name="diary"]')
  const block = diary.getByTestId('self-check-block')
  await expect(block).toBeVisible()
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
  await shot(page, 'app-self-check-catalog')
  await tests.getByTestId('tests-search').fill('трев')
  await expect(tests.getByTestId('tests-card-gad7')).toBeVisible()
  await expect(tests.getByTestId('tests-card-phq9')).toHaveCount(0)
  await shot(page, 'app-self-check-search')
  await tests.getByTestId('tests-search').fill('яхта')
  await expect(tests.getByTestId('tests-empty')).toBeVisible()
  await tests.getByTestId('tests-search').fill('')

  // ── без сети: тест проходится, результат виден ─────────────────────────
  await page.context().setOffline(true)
  await tests.getByTestId('tests-start-rosenberg').click()
  for (let i = 0; i < 10; i++) await page.getByTestId('test-option-2').click()
  await expect(page.getByTestId('result-score')).toBeVisible()
  await shot(page, 'app-self-check-offline-result')
  await page.getByTestId('result-close').click()
  await page.context().setOffline(false)
})
