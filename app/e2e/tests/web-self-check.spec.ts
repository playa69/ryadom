import { clearMailbox } from '../support/mail'
import { expect, test } from '../support/fixtures'
import { SELF_CHECK_ON } from '../support/flags'
import { openWebApp, registerAndConfirm, uniqueEmail } from '../support/web'

/**
 * Тесты внутри приложения, веб (`REQ-WELL-06`…`REQ-WELL-08`, `openspec/changes/add-self-check-tests`):
 * блок «Самопроверка» в «Дневнике», сегмент «Тесты» с поиском, прохождение в листе («Назад», «Прервать
 * тест?»), результат без диагноза, кризисный пункт PHQ-9 открывает экран помощи и лист SOS, тест
 * проходится без сети. Сохранение и история появятся с серверной частью (миграция 0010), здесь их нет.
 * Один сценарий на одну регистрацию, как в остальных web-спеках.
 */
test.skip(!SELF_CHECK_ON, 'тесты выключены (E2E_SELF_CHECK=0): блока и сегмента нет, см. web-diary')

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
  await expect(crisis).toContainText('Ты отметил(а), что бывают мысли о смерти')
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
  await expect(page.getByTestId('result-level')).toHaveText('сильная выраженность')
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

/** One pass of a test: a tap per question. */
async function answerAll(page: import('@playwright/test').Page, values: number[]) {
  for (const v of values) await page.getByTestId(`test-option-${v}`).click()
}

test('тесты: согласие, сохранение, история с графиком, удаление, ошибка красным тостом, профиль', async ({ page, shot }) => {
  test.setTimeout(240_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-self-check-save'))
  await openWebApp(page, '/diary')
  const notice = page.getByTestId('notice')

  // ── первое сохранение: лист согласия, «Не сохранять» возвращает к результату ──
  await page.getByTestId('self-check-start-gad7').click()
  await answerAll(page, [1, 2, 1, 1, 1, 1, 1])
  await expect(page.getByTestId('result-score')).toContainText('8')
  await page.getByTestId('result-save').click()
  const consent = page.getByTestId('test-consent')
  await expect(consent).toContainText('Сохранить результат?')
  await expect(consent).toContainText('Агент их не читает')
  await shot(page, 'web-self-check-consent')
  await page.getByTestId('consent-decline').click()
  await expect(page.getByTestId('test-result')).toBeVisible()

  // ── согласился: результат сохранён, зелёный тост, строка в «Самопроверке» ──
  await page.getByTestId('result-save').click()
  await page.getByTestId('consent-accept').click()
  await expect(notice.filter({ hasText: 'Результат сохранён' })).toHaveAttribute('data-kind', 'success')
  await expect(page.getByTestId('test-result')).toHaveCount(0)
  await expect(page.getByTestId('saved-line-gad7')).toContainText('8/21 — лёгкая выраженность')
  await shot(page, 'web-self-check-saved')

  // ── второй результат: согласие уже есть, лист не показывается ──────────
  await page.getByTestId('self-check-start-gad7').click()
  await answerAll(page, [0, 0, 0, 0, 0, 0, 0])
  await page.getByTestId('result-save').click()
  await expect(notice.filter({ hasText: 'Результат сохранён' }).last()).toBeVisible()
  await expect(page.getByTestId('saved-line-gad7')).toContainText('0/21 — минимальная выраженность')

  // ── экран теста: история, график из двух точек, удаление одного результата ──
  await page.getByTestId('self-check-history-gad7').click()
  await expect(page.getByTestId('history-row')).toHaveCount(2)
  await expect(page.getByTestId('history-chart-point')).toHaveCount(2)
  await shot(page, 'web-self-check-history')
  await page.getByTestId('history-delete').first().click()
  await expect(page.getByTestId('history-confirm')).toContainText('исчезнет с сервера')
  await shot(page, 'web-self-check-delete-one')
  await page.getByTestId('history-confirm-yes').click()
  await expect(page.getByTestId('history-row')).toHaveCount(1)
  await expect(page.getByTestId('history-chart-empty')).toBeVisible()
  await shot(page, 'web-self-check-history-one')
  // Все результаты теста: окно закрывается, строка снова с длиной теста.
  await page.getByTestId('history-delete-test').click()
  await page.getByTestId('history-confirm-yes').click()
  await expect(page.getByTestId('test-history')).toHaveCount(0)
  await expect(page.getByTestId('saved-line-gad7')).toHaveCount(0)

  // ── ошибка сохранения — тот же тост, красный; результат остаётся ─────────
  await page.route('**/api/self-check/results', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()))
  await page.getByTestId('self-check-start-gad7').click()
  await answerAll(page, [1, 1, 1, 1, 1, 1, 1])
  await page.getByTestId('result-save').click()
  await expect(notice.filter({ hasText: 'Не получилось сохранить' })).toHaveAttribute('data-kind', 'error')
  await expect(page.getByTestId('test-result')).toBeVisible()
  await shot(page, 'web-self-check-save-error')
  await page.unroute('**/api/self-check/results')
  await page.getByTestId('result-save').click()
  await expect(page.getByTestId('saved-line-gad7')).toContainText('7/21')

  // ── профиль → «Данные»: удалить все результаты, отозвать согласие ─────────
  await openWebApp(page, '/profile')
  await expect(page.getByTestId('profile-data')).toBeVisible()
  await shot(page, 'web-self-check-profile-data')
  await page.getByTestId('row-delete-self-check').click()
  await expect(page.getByTestId('self-check-confirm-text')).toContainText('Исчезнут результаты всех тестов')
  await page.getByTestId('self-check-confirm-yes').click()
  await expect(notice.filter({ hasText: 'Все результаты тестов удалены' })).toBeVisible()
  await page.getByTestId('row-revoke-self-check').click()
  await expect(page.getByTestId('self-check-confirm-text')).toContainText('больше не будем их хранить')
  await shot(page, 'web-self-check-revoke')
  await page.getByTestId('self-check-confirm-yes').click()
  await expect(page.getByTestId('row-revoke-self-check')).toHaveCount(0)
  // После отзыва следующее сохранение снова спрашивает согласие.
  await openWebApp(page, '/diary')
  await page.getByTestId('self-check-start-gad7').click()
  await answerAll(page, [1, 1, 1, 1, 1, 1, 1])
  await page.getByTestId('result-save').click()
  await expect(page.getByTestId('test-consent')).toBeVisible()
})
