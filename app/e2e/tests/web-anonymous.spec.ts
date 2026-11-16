import { randomBytes } from 'node:crypto'
import { ANONYMOUS_RETENTION_DAYS, POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { APP_URL } from '../playwright.config'
import {
  dismissMemoryInvite,
  button,
  checkConsent,
  closeSidebar,
  dialogInput,
  expectNoHorizontalOverflow,
  field,
  goTo,
  isPhone,
  homeInput,
  messages,
  modal,
  modalButton,
  openProfile,
  openSidebar,
  openSignIn,
  openWebApp,
  PASSWORD,
  registerAndConfirm,
  signIn,
  startAnonymously,
  talkButton,
  uniqueEmail,
  watchApiCalls,
  watchCsp,
} from '../support/web'
import { clearMailbox, waitForCode } from '../support/mail'
import {
  deviceLogin,
  profileOf,
  sessionAlive,
  startDialogRefusal,
  storedDevice,
  trackSession,
} from '../support/session'
import { step } from '../support/evidence'
import { expect, test } from '../support/fixtures'

// A headless browser has no microphone of its own: the voice start needs the fake device and its
// permission, the same way web-dialog.spec.ts gets them (the desktop project grants nothing by itself).
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
})

/**
 * Anonymous entry, the way a person meets it: home itself right away — the separate consent gate is
 * gone, and the first action that would start a conversation (a sent text, «Поговорить», the
 * microphone) opens the consent window over the page instead. «Продолжить» there runs the waiting
 * start: the account is made behind it, the consents recorded, and the typed text goes out once or the
 * voice begins. Later visits need no window at all. A profile that offers an address where it has
 * something to give, and a server that keeps to what the app promises.
 * `openspec/changes/add-fast-dialog-start`, «Первый экран: разговор с первого действия» and
 * «Согласие при первом действии».
 *
 * Scenarios rather than one test per step, for the reason the account scenarios give: every test
 * would start its own session, and the entry points are rate limited per address.
 */

const DEVICE_ID = /^[\w-]{16,64}$/
const DEVICE_KEY = /^[\w-]{32,128}$/

test('первый запуск: главная сразу, согласие окном при первом действии; дальше без экранов', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(120_000)
  const violations = await watchCsp(page)
  const session = trackSession(page)
  const apiCalls = watchApiCalls(page)

  // ── a new visitor: home itself, no gate before it ─────────────────────────
  // `openspec/changes/add-fast-dialog-start`, «Первый экран: разговор с первого действия».
  await openWebApp(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByTestId('terms-gate'), 'предварительного ворота больше нет').toHaveCount(0)
  await expect(homeInput(page)).toBeVisible()
  await expect(page.getByTestId('home-talk')).toBeEnabled()
  await expect(page.getByTestId('home-mic')).toBeVisible()
  await expect(page.getByTestId('home-suggestions')).toBeVisible()
  // The same frame as for an account: SOS in the header, the menu with «Войти» at its foot.
  await expect(page.getByRole('button', { name: 'SOS' })).toBeVisible()
  await openSidebar(page)
  await expect(page.getByTestId('have-account')).toHaveText('Войти')
  await closeSidebar(page)
  // «Люди рядом» are open without an account too.
  await openWebApp(page, '/people')
  await expect(page).toHaveURL(/\/people$/)
  await expect(page.getByText('Позвонить прямо сейчас')).toBeVisible()
  await openWebApp(page)
  await expect(page.getByTestId('consent-notice')).toContainText('ИИ для самоподдержки')
  await expect(page.getByText('В опасной ситуации звони 112.')).toBeVisible()
  // `openspec/changes/update-privacy-policy`, «Человек знает о сроке хранения разговоров».
  await expect(page.getByTestId('guest-note')).toContainText(
    'Разговоры хранятся 30 дней после последнего сообщения.',
  )
  await expect(page.getByTestId('guest-note')).toContainText(
    'Без почты аккаунт удаляется через 90 дней без визитов.',
  )
  // The memory choice waits inside the collapsed «Настроить разговор», not on the way to the start.
  await expect(page.getByTestId('memory-switch')).toBeHidden()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-welcome')
  await step(
    page,
    'home-before-consent',
    'Первый вход: главная сразу — поле, подсказки, голосовой старт; ворота нет',
  )
  // Nothing is made before the explicit tick and press: no account, no key on the device, no call.
  expect(await storedDevice(page), 'до согласия удостоверения нет').toBeNull()
  expect(apiCalls(), 'открытие главной не создаёт запросов').toEqual([])

  // ── typing and a suggestion are local ──────────────────────────────────────
  await homeInput(page).fill('Сегодня был длинный день')
  await page.getByTestId('home-suggestion-2').click()
  await expect(homeInput(page)).toHaveValue('Мне тревожно')
  expect(apiCalls(), 'ввод и подсказка не создают запросов').toEqual([])
  expect(await storedDevice(page), 'и удостоверения всё ещё нет').toBeNull()

  // ── the first send opens the consent window over home ─────────────────────
  // `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии»: «Окно согласия при
  // отправке текста», ««Продолжить» неактивна до отметки».
  await homeInput(page).press('Enter')
  await expect(modal(page).getByRole('heading', { name: 'Перед началом' })).toBeVisible()
  await expect(modal(page).getByTestId('data-consent-toggle')).not.toBeChecked()
  await expect(modal(page).getByTestId('consent-continue')).toBeDisabled()
  await expect(modal(page).getByRole('link', { name: 'условия использования', exact: true })).toHaveAttribute(
    'href',
    /\/terms$/,
  )
  await expect(
    modal(page).getByRole('link', {
      name: 'согласие на обработку персональных данных',
      exact: true,
    }),
  ).toHaveAttribute('href', /\/consent$/)
  await expect(page).toHaveURL(/\/home$/)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-consent-window')
  await step(
    page,
    'consent-window',
    'Отправка текста без согласия: окно поверх главной, флажок снят, «Продолжить» неактивна',
  )
  expect(apiCalls(), 'окно открылось без запроса').toEqual([])
  expect(await storedDevice(page), 'аккаунт не создан').toBeNull()

  // Esc closes it: the draft and the intent stay, nothing is sent; the next action opens it again.
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)
  await expect(homeInput(page)).toHaveValue('Мне тревожно')
  expect(apiCalls(), 'закрытие Esc не отправляет запрос').toEqual([])
  await step(page, 'consent-closed-esc', 'Esc закрыл окно: черновик на месте, запроса нет')

  // The backdrop closes it the same way (the point is over the page, away from the header's controls).
  await page.getByTestId('home-talk').click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await expect(modal(page).getByTestId('data-consent-toggle'), 'окно монтируется заново').not.toBeChecked()
  const viewport = page.viewportSize()!
  await page.mouse.click(viewport.width / 2, 150)
  await expect(modal(page)).toHaveCount(0)
  await expect(homeInput(page)).toHaveValue('Мне тревожно')
  expect(apiCalls(), 'закрытие фоном не отправляет запрос').toEqual([])

  // ── «Продолжить» after the tick runs the waiting start ─────────────────────
  // «Подтверждение продолжает исходное действие», «(Web) Начало текстом».
  await page.getByTestId('home-talk').click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await modal(page).getByTestId('data-consent-toggle').check()
  await expect(modal(page).getByTestId('consent-continue')).toBeEnabled()
  await modal(page).getByTestId('consent-continue').click()
  await expect(page).toHaveURL(/\/dialog\//, { timeout: 30_000 })
  await expect(page.getByText('Я рядом. С чего начнём?').first()).toBeVisible({ timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'user').first()).toContainText('Мне тревожно')
  // The reply has arrived, and the text still went out exactly once; nobody started listening.
  await expect(messages(page, 'assistant')).toHaveCount(2, { timeout: 30_000 })
  await expect(messages(page, 'user'), 'первый текст не продублировался').toHaveCount(1)
  await expect(page.getByTestId('dialog-voice'), 'текстовый вид: голос не включался').toHaveCount(0)
  await expect(page.getByTestId('memory-invite'), 'окно про память не мешает началу').toHaveCount(0)
  await step(
    page,
    'consent-continued',
    'После «Продолжить» разговор начался сам: приветствие, затем черновик первым сообщением',
  )
  const accountId = session.userId()
  const device = await storedDevice(page)
  expect(device?.deviceId, 'идентификатор устройства сохранён').toMatch(DEVICE_ID)
  expect(device?.deviceKey, 'ключ устройства сохранён').toMatch(DEVICE_KEY)

  // The server holds what was agreed to, and the account has nothing else: no address, no name.
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email: null,
    name: null,
    consentsCompleted: true,
    consentVersion: POLICY_VERSION,
  })
  expect(await violations(), 'нарушения политики безопасности').toEqual([])

  // ── the root keeps the session; no window is asked again ───────────────────
  await dismissMemoryInvite(page)
  await openWebApp(page)
  await expect(talkButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/home$/)
  // The foot of home is the same with an account: the agreement with the terms and the policy, and 112.
  await expect(page.getByTestId('consent-notice')).toBeVisible()
  await expect(page.getByTestId('guest-note')).toHaveCount(0)

  // ── the session is gone but the device is known: `/` signs back in, with no screen at all ─
  await page.evaluate(() => {
    localStorage.removeItem('ryadom_refreshToken')
    localStorage.removeItem('ryadom.user')
  })
  await openWebApp(page)
  await expect(talkButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/home$/)
  expect(session.userId(), 'тот же аккаунт, не новый').toBe(accountId)

  // ── a browser that knows nothing about this person lands on home itself ────
  await page.evaluate(() => localStorage.clear())
  await openWebApp(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(homeInput(page)).toBeVisible()
  await expect(page.getByTestId('terms-gate'), 'ворота нет и для нового браузера').toHaveCount(0)
})

test('первый запуск голосом: «Поговорить» открывает окно согласия, подтверждение начинает голосовой разговор', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const apiCalls = watchApiCalls(page)
  await openWebApp(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(homeInput(page)).toBeVisible()

  // `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии»: «Окно согласия при
  // голосовом старте» — the microphone press only opens the window, the conversation does not begin.
  await page.getByTestId('home-mic').click()
  await expect(modal(page).getByRole('heading', { name: 'Перед началом' })).toBeVisible()
  await expect(modal(page).getByTestId('consent-continue')).toBeDisabled()
  expect(apiCalls(), 'до подтверждения запросов нет').toEqual([])
  expect(await storedDevice(page), 'аккаунт не создан').toBeNull()
  await step(page, 'consent-voice-window', 'Голосовой старт без согласия: то же окно, разговор не начался')

  // The cross closes it without a request, and the intent waits for the next press.
  await modal(page).getByTestId('consent-close').click()
  await expect(modal(page)).toHaveCount(0)
  expect(apiCalls(), 'закрытие крестиком не отправляет запрос').toEqual([])

  // «Подтверждение продолжает исходное действие» with a voice intent: the voice view opens and,
  // after the greeting, starts listening by itself.
  await talkButton(page).click()
  await expect(modal(page).getByTestId('consent-modal')).toBeVisible()
  await modal(page).getByTestId('data-consent-toggle').check()
  await expect(modal(page).getByTestId('consent-continue')).toBeEnabled()
  await modal(page).getByTestId('consent-continue').click()
  await expect(page).toHaveURL(/\/dialog\//, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Остановить запись' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('voice-caption')).not.toBeEmpty({ timeout: 30_000 })
  await step(
    page,
    'consent-voice-start',
    'После «Продолжить» открыт голосовой вид: приветствие под шаром, прослушивание началось',
  )
})

test('сервер не начинает разговор без согласий, и «мне нет 18» — отдельный отказ', async ({ request }) => {
  const device = {
    deviceId: randomBytes(16).toString('base64url'),
    deviceKey: randomBytes(32).toString('base64url'),
  }
  // The account is made first and the agreements come after (the first screen does both in a row),
  // so a client that skips the second step is stopped here, not by the screen.
  const { tokens } = await deviceLogin(request, device)
  const asClient = { Authorization: `Bearer ${tokens.accessToken}` }
  expect(await startDialogRefusal(request, tokens.accessToken)).toBe('CONSENT_REQUIRED')

  const consent = (data: object) =>
    request.post(`${APP_URL}/api/auth/me/consents`, { headers: asClient, data })
  const all = {
    ageConfirmed: true,
    disclaimerAccepted: true,
    offerAccepted: true,
    offerVersion: POLICY_VERSION,
  }

  const minor = (await (await consent({ ...all, ageConfirmed: false })).json()) as { errorCode?: string }
  expect(minor.errorCode).toBe('AGE_RESTRICTED')
  const partial = (await (await consent({ ...all, offerAccepted: false })).json()) as { errorCode?: string }
  expect(partial.errorCode).toBe('CONSENT_DECLINED')
  expect(await startDialogRefusal(request, tokens.accessToken), 'отказы ничего не записали').toBe(
    'CONSENT_REQUIRED',
  )

  expect(((await (await consent(all)).json()) as { status: boolean }).status).toBe(true)
  expect(await startDialogRefusal(request, tokens.accessToken)).toBeNull()
})

test('аккаунт без почты: профиль, привязка, подтверждение — выход появляется, ключ устройства забыт', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const email = uniqueEmail('web-anonymous')
  await clearMailbox()

  await openWebApp(page)
  await startAnonymously(page)
  const accountId = session.userId()

  // ── the profile offers an address, not a password, and says how long the account lives ─
  await openProfile(page)
  await expect(page.getByTestId('profile-email')).toHaveText('Без регистрации')
  await expect(page.getByTestId('profile-name')).toHaveText('Гость')
  await expect(page.getByTestId('row-link-email')).toBeVisible()
  await expect(page.getByTestId('row-change-password'), 'у аккаунта без пароля его нечем менять').toHaveCount(
    0,
  )
  await expect(page.getByTestId('row-confirm-email')).toHaveCount(0)
  await expect(page.getByTestId('row-sessions'), 'у гостя одно устройство: смотреть нечего').toHaveCount(0)
  await expect(
    page.getByText(new RegExp(`${ANONYMOUS_RETENTION_DAYS} дней после последнего визита`)),
  ).toBeVisible()
  // Nothing to sign out of: this phone is the only way in. Leaving is going to another account.
  await expect(page.getByTestId('logout'), 'выхода из такого аккаунта нет').toHaveCount(0)
  await expect(page.getByTestId('row-switch-account')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-profile')

  // The sidebar says it is a guest and offers to keep the conversations, the way other chats do for
  // someone who has not signed in; a signed-in account gets no such card.
  await openSidebar(page)
  await expect(page.getByTestId('account-menu')).toContainText('Гость')
  await expect(page.getByTestId('guest-card')).toContainText('Сохрани аккаунт')
  await expect(page.getByTestId('guest-card-link')).toHaveAttribute('href', '/profile?linkEmail=1')
  await shot(page, 'web-anonymous-guest-card')
  await closeSidebar(page)

  await page.getByTestId('edit-name').click()
  await modal(page).locator('input[name="name"]').fill('Аноним')
  await page.getByTestId('name-save').click()
  await expect(page.getByTestId('profile-name')).toHaveText('Аноним')

  // ── linking: the form checks before it asks, then the code from the email ─
  const address = page.getByTestId('link-email-address')
  const password = page.getByTestId('link-email-password')
  const formError = page.getByTestId('form-error')
  await page.getByTestId('row-link-email').click()
  await expect(modal(page).getByRole('heading', { name: 'Почта для входа' })).toBeVisible()
  await expect(
    modal(page).getByText(new RegExp(`удаляется через ${ANONYMOUS_RETENTION_DAYS} дней`)),
  ).toBeVisible()
  await address.fill('not-an-address')
  await password.fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()
  await expect(formError).toHaveText('Проверь адрес почты')
  await address.fill(email)
  await password.fill('short')
  await page.getByTestId('link-email-submit').click()
  await expect(formError).toContainText('Пароль')
  await password.fill(PASSWORD)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-link-email')
  await page.getByTestId('link-email-submit').click()

  const code = page.getByTestId('link-email-code')
  await expect(code).toBeVisible({ timeout: 20_000 })
  await code.fill('000000')
  await page.getByTestId('link-email-confirm').click()
  await expect(formError).toContainText('Код не подошёл', { timeout: 20_000 })
  await code.fill(await waitForCode(email))
  await page.getByTestId('link-email-confirm').click()
  await expect(page.getByText('Почта подтверждена')).toBeVisible({ timeout: 20_000 })
  await expect(modal(page)).toHaveCount(0)

  // ── now it is an ordinary account: a password, a way out, and no device key ─
  await expect(page.getByTestId('profile-email')).toHaveText(email)
  await expect(page.getByTestId('profile-name')).toHaveText('Аноним')
  await expect(page.getByTestId('row-change-password')).toBeVisible()
  await expect(
    page.getByTestId('row-sessions'),
    'с подтверждённой почтой войти можно с другого устройства',
  ).toBeVisible()
  await expect(page.getByTestId('row-link-email')).toHaveCount(0)
  await expect(page.getByTestId('row-switch-account')).toHaveCount(0)
  await expect(page.getByTestId('logout')).toBeVisible()
  await expect(page.getByText(/дней после последнего визита/)).toHaveCount(0)
  await openSidebar(page)
  await expect(page.getByTestId('guest-card'), 'у аккаунта с почтой карточки гостя нет').toHaveCount(0)
  await expect(page.getByTestId('account-menu')).toContainText(email)
  await closeSidebar(page)
  expect(await storedDevice(page), 'ключ устройства забыт: у аккаунта есть пароль').toBeNull()
  expect(await profileOf(request, session.accessToken())).toMatchObject({
    id: accountId,
    email,
    isEmailConfirmed: true,
    consentsCompleted: true,
  })
  await shot(page, 'web-anonymous-linked')

  // ── signing out really signs out: the next visit is a stranger's, the way back is the address ─
  await page.getByTestId('logout').click()
  await page.getByTestId('logout-confirm').click()
  await expect(page).toHaveURL(/\/login$/)
  await openWebApp(page)
  // No gate for a stranger: home itself, the sign-in stays at the foot of the menu.
  await expect(page.getByTestId('terms-gate')).toHaveCount(0)
  await expect(homeInput(page)).toBeVisible()
  await openSignIn(page)
  await signIn(page, email)
  await openProfile(page)
  await expect(page.getByTestId('profile-name'), 'тот же аккаунт со всем, что в нём было').toHaveText(
    'Аноним',
  )
  expect(session.userId()).toBe(accountId)
})

test('почта уже занята: что будет с разговорами сказано, путь в тот аккаунт есть', async ({
  page,
  newDevice,
  shot,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const taken = uniqueEmail('web-taken')
  await clearMailbox()

  // Someone already has an account with this address, on another device.
  const owner = await newDevice()
  const ownerSession = trackSession(owner)
  await openWebApp(owner)
  await registerAndConfirm(owner, taken, 'Хозяйка')

  await openWebApp(page)
  await startAnonymously(page)
  const anonymousId = session.userId()
  await openProfile(page)
  await page.getByTestId('row-link-email').click()
  await page.getByTestId('link-email-address').fill(taken)
  await page.getByTestId('link-email-password').fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()

  // The answer says it plainly, and offers the other account.
  const formError = page.getByTestId('form-error')
  await expect(formError).toContainText('Эта почта уже занята', { timeout: 20_000 })
  await expect(formError).toContainText('не перенесутся')
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-email-taken')
  await page.getByTestId('link-email-switch').click()
  await expect(modal(page).getByRole('heading', { name: 'Войти в другой аккаунт' })).toBeVisible()
  await expect(modal(page)).toContainText(`через ${ANONYMOUS_RETENTION_DAYS} дней`)
  await shot(page, 'web-anonymous-switch-account')

  // Declining leaves everything as it was.
  await modalButton(page, 'Отмена').click()
  await expect(modal(page)).toHaveCount(0)
  expect(await storedDevice(page), 'отказавшись, человек остаётся в своём аккаунте').not.toBeNull()

  await page.getByTestId('row-switch-account').click()
  await page.getByTestId('switch-account-confirm').click()
  await expect(page).toHaveURL(/\/login$/)
  expect(await storedDevice(page), 'уйдя, человек забыл удостоверение: вернуться нельзя').toBeNull()
  await signIn(page, taken)
  await openProfile(page)
  await expect(page.getByTestId('profile-email')).toHaveText(taken)
  expect(session.userId(), 'это тот аккаунт, а не прежний анонимный').toBe(ownerSession.userId())
  expect(session.userId()).not.toBe(anonymousId)
})

test('привязка почты, начатая и брошенная, продолжается с шага кода', async ({ page }) => {
  test.setTimeout(120_000)
  const email = uniqueEmail('web-pending')
  await clearMailbox()

  await openWebApp(page)
  await startAnonymously(page)
  await openProfile(page)
  await page.getByTestId('row-link-email').click()
  await page.getByTestId('link-email-address').fill(email)
  await page.getByTestId('link-email-password').fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()
  await expect(page.getByTestId('link-email-code')).toBeVisible({ timeout: 20_000 })

  // The dialog is closed without the code, and the page is reloaded for good measure.
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)
  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByTestId('profile-email')).toHaveText(email)
  const confirmRow = page.getByTestId('row-confirm-email')
  await expect(confirmRow).toContainText(email)
  await expect(page.getByTestId('row-link-email'), 'адрес уже указан').toHaveCount(0)
  await expect(
    page.getByTestId('row-sessions'),
    'пока почта не подтверждена, список устройств не нужен',
  ).toHaveCount(0)
  // Not confirmed yet: this phone is still the only way in, so there is still nothing to sign out of.
  await expect(page.getByTestId('logout')).toHaveCount(0)
  await expect(page.getByTestId('row-switch-account')).toBeVisible()

  // It opens at the code step, not at the form; a new code can be asked for and is the one that works.
  await confirmRow.click()
  const code = page.getByTestId('link-email-code')
  await expect(code).toBeVisible()
  await expect(page.getByTestId('link-email-address')).toHaveCount(0)
  await clearMailbox()
  await modalButton(page, 'Отправить ещё раз').click()
  await expect(page.getByText('Отправили новый код')).toBeVisible()
  await code.fill(await waitForCode(email))
  await page.getByTestId('link-email-confirm').click()
  await expect(page.getByText('Почта подтверждена')).toBeVisible({ timeout: 20_000 })
  await expect(modal(page)).toHaveCount(0)
  await expect(confirmRow).toHaveCount(0)
  await expect(page.getByTestId('logout')).toBeVisible()
})

test('удаление аккаунта без регистрации: устройство забыто, дальше — первый экран и новый аккаунт', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const session = trackSession(page)

  await openWebApp(page)
  await startAnonymously(page)
  const oldAccount = session.userId()
  const oldSession = session.refreshToken()
  const oldDevice = (await storedDevice(page))!
  expect(oldDevice).not.toBeNull()

  await openProfile(page)
  await page.getByTestId('edit-name').click()
  await modal(page).locator('input[name="name"]').fill('Аноним')
  await page.getByTestId('name-save').click()
  await expect(page.getByTestId('profile-name')).toHaveText('Аноним')

  await page.getByTestId('row-delete-account').click()
  await expect(page.getByText('Удаляется аккаунт без регистрации')).toBeVisible()
  // Two consequences, not three: there is no address to free.
  await expect(page.getByTestId('consequences').getByRole('listitem')).toHaveCount(2)
  await expect(page.getByText('Почта освободится')).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
  await checkConsent(page)
  await page.getByTestId('delete-account').click()
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByTestId('deleted-message')).toBeVisible({ timeout: 30_000 })
  expect(await storedDevice(page), 'ключ устройства стёрт вместе с аккаунтом').toBeNull()
  await page.getByTestId('deleted-ok').click()
  // Back at the start — home itself, not a sign-in for an account the person never had.
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByTestId('terms-gate')).toHaveCount(0)
  await expect(homeInput(page)).toBeVisible()

  expect(await sessionAlive(request, oldSession), 'сессия удалённого аккаунта закончена').toBe(false)

  // The old key no longer leads to the old account: the same key makes a new one.
  const reused = await deviceLogin(request, oldDevice)
  expect(reused.isNewAccount).toBe(true)
  expect(reused.user.id).not.toBe(oldAccount)

  // And the same browser starts over: a new account with a key of its own, and no name from before.
  await startAnonymously(page)
  expect(session.userId()).not.toBe(oldAccount)
  const newDevice = (await storedDevice(page))!
  expect(newDevice.deviceId).not.toBe(oldDevice.deviceId)
  await openProfile(page)
  await expect(page.getByTestId('profile-name'), 'имя прежнего аккаунта не вернулось').toHaveText('Гость')
})

test('после первого разговора предложена почта, а в журнале напоминание; зарегистрированному — нет', async ({
  page,
  shot,
}) => {
  test.setTimeout(150_000)
  await openWebApp(page)
  await startAnonymously(page)

  await homeInput(page).fill('Сегодня было тяжело')
  await homeInput(page).press('Enter')
  await expect(page).toHaveURL(/\/dialog\/[^/]+$/, { timeout: 30_000 })
  await expect(messages(page, 'user')).toHaveCount(1, { timeout: 30_000 })
  await expect(messages(page, 'assistant').last()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-streaming="true"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(dialogInput(page)).toBeVisible()

  await page.getByTestId('dialog-end').click()
  await page.getByTestId('takeaway-input').fill('Стало чуть легче')
  await modalButton(page, 'Завершить').click()
  await expect(modal(page).getByRole('heading', { name: 'Спасибо, что поговорил(а)' })).toBeVisible({
    timeout: 30_000,
  })

  // The conversation is over, and the one thing the person stands to lose is said out loud.
  const offer = page.getByTestId('alert-offer')
  await expect(offer).toContainText(`${ANONYMOUS_RETENTION_DAYS} дней`)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-closing-offer')
  await page.getByTestId('alert-offer-action').click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(modal(page).getByRole('heading', { name: 'Почта для входа' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)

  // The journal reminds as well, with a way to the same dialog.
  await goTo(page, 'Все разговоры')
  await expect(page).toHaveURL(/\/diary\/journal$/)
  const reminder = page.getByTestId('journal-link-email')
  await expect(page.getByTestId('journal-item').first()).toBeVisible({ timeout: 20_000 })
  if (isPhone(page)) {
    await expect(reminder).toBeVisible()
    await expect(reminder.getByRole('link', { name: 'Привязать почту' })).toHaveAttribute(
      'href',
      '/profile?linkEmail=1',
    )
  } else {
    // Where the sidebar is a column it carries the same offer, and the journal does not repeat it.
    await expect(reminder).toBeHidden()
    await expect(page.getByTestId('guest-card')).toBeVisible()
  }
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-anonymous-journal')
})

test('вход по почте на новом устройстве даёт тот же аккаунт, а прежнее удостоверение ему не мешает', async ({
  page,
  newDevice,
}) => {
  test.setTimeout(180_000)
  const session = trackSession(page)
  const email = uniqueEmail('web-second-device')
  await clearMailbox()

  await openWebApp(page)
  await startAnonymously(page)
  const accountId = session.userId()
  await openProfile(page)
  await page.getByTestId('row-link-email').click()
  await page.getByTestId('link-email-address').fill(email)
  await page.getByTestId('link-email-password').fill(PASSWORD)
  await page.getByTestId('link-email-submit').click()
  await page.getByTestId('link-email-code').fill(await waitForCode(email))
  await page.getByTestId('link-email-confirm').click()
  await expect(page.getByText('Почта подтверждена')).toBeVisible({ timeout: 20_000 })

  // Another phone: the address and the password are all it needs.
  const other = await newDevice()
  const otherSession = trackSession(other)
  await openWebApp(other)
  await dismissMemoryInvite(other) // a new device: the sheet "Рядом теперь запоминает важное" is not this test's subject
  await expect(other.getByTestId('terms-gate')).toHaveCount(0)
  await expect(homeInput(other)).toBeVisible()
  await openSignIn(other)
  await field(other, 'email').fill(email)
  await field(other, 'password').fill(PASSWORD)
  await button(other, 'Войти').click()
  await expect(talkButton(other)).toBeVisible({ timeout: 30_000 })
  expect(otherSession.userId()).toBe(accountId)
  await openProfile(other)
  await expect(other.getByTestId('profile-name')).toHaveText('—')
  await expect(other.getByTestId('profile-email')).toHaveText(email)
  await expect(other.getByTestId('logout'), 'у аккаунта с почтой выход есть').toBeVisible()
})
