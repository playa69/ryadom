import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { openWebApp, registerAndConfirm, uniqueEmail } from '../support/web'

/**
 * Тесты внутри приложения, веб (`REQ-WELL-06`…`REQ-WELL-08`, `openspec/changes/add-self-check-tests`):
 * блок «Самопроверка» в «Дневнике», сегмент «Тесты» с поиском, прохождение в листе («Назад», «Прервать
 * тест?»), результат без диагноза, кризисный пункт PHQ-9 открывает экран помощи и лист SOS, тест
 * проходится без сети. Сохранение и история появятся с серверной частью (миграция 0010), здесь их нет.
 * Один сценарий на одну регистрацию, как в остальных web-спеках.
 */
test.use({ video: 'on' })

test('тесты: самопроверка, каталог, прохождение, результат, кризисный пункт, без сети', async ({ page, shot }) => {
  test.setTimeout(180_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-self-check'))
  await openWebApp(page, '/diary')

  // ── блок «Самопроверка» в «Дневнике»: шесть шкал волны 1 ────────────────
  const block = page.getByTestId('self-check-block')
  await expect(block).toBeVisible()
  await expect(block).toContainText('Научные скрининговые опросники. Это не диагноз — только ориентир.')
  for (const id of ['gad7', 'phq9', 'rosenberg', 'wellbeing', 'stress', 'burnout']) {
    await expect(page.getByTestId(`self-check-row-${id}`)).toBeVisible()
  }
  await expect(page.getByTestId('self-check-row-gad7')).toContainText('GAD-7 · 7 вопросов · ~2 мин')
  await shot(page, 'web-self-check-block')

  // ── GAD-7: первый вопрос, прогресс, ответ ведёт к следующему, «Назад» хранит ответ ──
  await page.getByTestId('self-check-start-gad7').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 1 из 7')
  await expect(page.getByTestId('test-back')).toHaveCount(0)
  await shot(page, 'web-self-check-question-1')
  await page.getByTestId('test-option-1').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 2 из 7')
  await page.getByTestId('test-option-2').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 3 из 7')
  await page.getByTestId('test-back').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 2 из 7')
  await expect(page.getByTestId('test-option-2')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'web-self-check-back')

  // ── «×» после трёх ответов спрашивает, «Продолжить» возвращает на тот же вопрос ──
  await page.getByTestId('test-option-2').click()
  await page.getByTestId('test-option-1').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 4 из 7')
  await page.getByTestId('test-close').click()
  await expect(page.getByTestId('test-interrupt')).toContainText('Прервать тест?')
  await expect(page.getByTestId('test-interrupt')).toContainText('Ответы не сохранятся.')
  await shot(page, 'web-self-check-interrupt')
  await page.getByTestId('test-continue').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 4 из 7')

  // ── дойти до результата: сумма 1+2+1+1+1+1+1 = 8 из 21, лёгкая выраженность ──
  for (const v of [1, 1, 1, 1]) await page.getByTestId(`test-option-${v}`).click()
  const result = page.getByTestId('test-result')
  await expect(result).toBeVisible()
  await expect(page.getByTestId('result-score')).toContainText('8')
  await expect(page.getByTestId('result-score')).toContainText('/ 21')
  await expect(page.getByTestId('result-level')).toHaveText('лёгкая выраженность')
  await expect(result).toContainText('Это скрининговый опросник, а не диагноз')
  await expect(page.getByTestId('result-retake')).toContainText('через 4 недели')
  await expect(page.getByTestId('result-specialist')).toHaveCount(0)
  await shot(page, 'web-self-check-result-mild')
  await page.getByTestId('result-close').click()
  await expect(page.getByTestId('test-result')).toHaveCount(0)

  // ── PHQ-9: тяжёлый результат и кризисный пункт 9 ──────────────────────
  await page.getByTestId('self-check-start-phq9').click()
  for (let i = 0; i < 8; i++) await page.getByTestId('test-option-3').click()
  await expect(page.getByTestId('test-progress-label')).toHaveText('Вопрос 9 из 9')
  await page.getByTestId('test-option-1').click()
  // Экран помощи до результата, без пропуска: Esc и клик мимо его не закрывают.
  const crisis = page.getByTestId('test-crisis')
  await expect(crisis).toBeVisible()
  await expect(crisis).toContainText('Спасибо, что ответил честно')
  await page.keyboard.press('Escape')
  await expect(crisis).toBeVisible()
  await expect(page.getByTestId('test-close')).toHaveCount(0)
  await shot(page, 'web-self-check-crisis')
  await page.getByTestId('crisis-call').click()
  await expect(page.getByRole('dialog', { name: 'Если сейчас тяжело' })).toBeVisible()
  await shot(page, 'web-self-check-sos')
  await page.keyboard.press('Escape')
  await expect(crisis).toBeVisible()
  await page.getByTestId('crisis-result').click()
  await expect(page.getByTestId('result-score')).toContainText('25')
  await expect(page.getByTestId('result-level')).toHaveText('высокая выраженность')
  await expect(page.getByTestId('result-specialist')).toContainText('Поговорить со специалистом')
  await expect(page.getByTestId('result-retake')).toContainText('через 2 недели')
  await shot(page, 'web-self-check-result-high')
  await page.getByTestId('result-close').click()

  // ── сегмент «Тесты»: каталог и поиск ────────────────────────────────────
  await page.getByTestId('diary-segment-tests').click()
  await expect(page).toHaveURL(/\/diary\/tests$/)
  await expect(page.getByTestId('tests-catalog')).toContainText('Это скрининг, а не диагноз')
  await expect(page.getByTestId('tests-card-gad7')).toBeVisible()
  await shot(page, 'web-self-check-catalog')
  await page.getByTestId('tests-search').fill('трев')
  await expect(page.getByTestId('tests-card-gad7')).toBeVisible()
  await expect(page.getByTestId('tests-card-phq9')).toHaveCount(0)
  await shot(page, 'web-self-check-search')
  await page.getByTestId('tests-search').fill('яхта')
  await expect(page.getByTestId('tests-empty')).toBeVisible()
  await page.getByTestId('tests-search').fill('')

  // ── без сети: тест проходится и показывает результат ───────────────────
  await page.context().setOffline(true)
  await page.getByTestId('tests-start-rosenberg').click()
  for (let i = 0; i < 10; i++) await page.getByTestId('test-option-2').click()
  await expect(page.getByTestId('result-score')).toBeVisible()
  await shot(page, 'web-self-check-offline-result')
  await page.getByTestId('result-close').click()
  await page.context().setOffline(false)
})
