import { WEB_URL } from '../playwright.config'
import {
  dismissMemoryInvite,
  button,
  checkConsent,
  expectNoHorizontalOverflow,
  expectSingleSos,
  field,
  isPhone,
  modal,
  modalButton,
  openProfile,
  openWebApp,
  pageTitle,
  PASSWORD,
  registerAndConfirm,
  signIn,
  sosButton,
  talkButton,
  uniqueEmail,
  viewportWidth,
  watchCsp,
} from '../support/web'
import { clearMailbox, waitForCode } from '../support/mail'
import { expect, test } from '../support/fixtures'

/**
 * The whole account path in the web app, the counterpart of app-account.spec.ts: sign-up with the
 * code from the email, SOS, the profile, password change, sign-out and sign-in again, deletion.
 *
 * One scenario rather than several tests, for the same reason as there: every test would sign in
 * again, and sign-in is rate limited per IP, so the suite would run into its own protection.
 *
 * It runs at both project sizes (a laptop and a phone), so every step has to hold with the sidebar
 * as a column and as a drawer. The whole run is a single page load, which is what lets the policy
 * watcher at the end speak for every screen visited on the way.
 */
test('путь аккаунта в вебе: регистрация, профиль, смена пароля, вход, удаление', async ({ page, shot }) => {
  test.setTimeout(150_000)
  const violations = await watchCsp(page)
  const email = uniqueEmail('web-account')
  await clearMailbox()

  // ── sign-up ──────────────────────────────────────────────────────────────
  await openWebApp(page)
  // The root has no screen of its own: a visitor with no account lands on the first screen, and the
  // sign-in is a door they open themselves.
  await expect(page).toHaveURL(/\/welcome$/)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-welcome')
  await page.getByTestId('have-account').click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(button(page, 'Войти')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-login')

  await registerAndConfirm(page, email)
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByTestId('home-greeting')).toContainText('Тест')
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-home')

  // ── SOS: help lines in one tap, one button whatever the width ────────────
  await expectSingleSos(page)
  await sosButton(page).click()
  await expect(modal(page).getByRole('heading', { name: 'Если сейчас тяжело' })).toBeVisible()
  await expect(modal(page).getByRole('link', { name: /112/ })).toBeVisible()
  await shot(page, 'web-sos')
  await modalButton(page, 'Закрыть').click()
  await expect(modal(page)).toHaveCount(0)

  // ── profile: from the account menu, a settings page ──────────────────────
  await openProfile(page)
  await expect(page.getByTestId('profile-email')).toHaveText(email)
  await expect(page.getByTestId('profile-name')).toHaveText('Тест')
  // The documents live on the landing: its address is runtime config of this server.
  await expect(page.getByTestId('row-terms')).toHaveAttribute('href', `${WEB_URL}/terms`)
  await expect(page.getByTestId('row-privacy')).toHaveAttribute('href', `${WEB_URL}/privacy`)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-profile')

  await page.getByTestId('edit-name').click()
  await expect(modal(page).getByRole('heading', { name: 'Имя' })).toBeVisible()
  await modal(page).locator('input[name="name"]').fill('Тест Рядом')
  await page.getByTestId('name-save').click()
  await expect(page.getByText('Имя сохранено')).toBeVisible()
  await expect(page.getByTestId('profile-name')).toHaveText('Тест Рядом')

  // The agent's voice: a man's until the person picks another one; the choice is saved on the account.
  await expect(page.getByTestId('voice-male')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('voice-female')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('voice-female').click()
  await expect(page.getByTestId('voice-female')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('voice-male')).toHaveAttribute('aria-pressed', 'false')

  // The help lines are also a page of their own: one column at every width, nothing sideways.
  await page.getByTestId('row-people').click()
  await expect(page).toHaveURL(/\/people$/)
  await expect(pageTitle(page)).toHaveText('Люди рядом')
  const lines = page.getByTestId('hotline')
  await expect(lines).toHaveCount(3)
  const [first, second, third] = await Promise.all([0, 1, 2].map((i) => lines.nth(i).boundingBox()))
  expect(second!.x, 'линии помощи в одну колонку').toBeCloseTo(first!.x, 0)
  expect(second!.y, 'вторая линия ниже первой').toBeGreaterThan(first!.y)
  expect(third!.y, 'третья линия ниже второй').toBeGreaterThan(second!.y)
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-people')
  // There is no "back" on this page: the profile is a menu item away.
  await openProfile(page)
  await expect(page.getByTestId('profile-name')).toBeVisible()
  // The profile is read from the server again, and the voice is still the one chosen.
  await expect(page.getByTestId('voice-female')).toHaveAttribute('aria-pressed', 'true')

  // ── password change ──────────────────────────────────────────────────────
  await page.getByTestId('row-change-password').click()
  await expect(pageTitle(page)).toHaveText('Изменить пароль')
  await expect(page.getByRole('heading', { name: 'Изменить пароль' })).toBeVisible()

  const nextPassword = `${PASSWORD}-new`
  await field(page, 'current-password').fill(PASSWORD)
  await field(page, 'new-password').fill(nextPassword)
  await field(page, 'repeat-password').fill(nextPassword)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-change-password')
  await page.getByTestId('change-password-submit').click()
  // Changing the password does not sign the person out: the screen returns to the profile.
  await expect(page.getByText('Пароль изменён')).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/\/profile$/)

  // ── sign out and in again: the new password is the one that works ────────
  // A second tab of the same browser shares the session; it must not outlive the sign-out.
  const otherTab = await page.context().newPage()
  await openWebApp(otherTab, '/home')
  await expect(talkButton(otherTab)).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('logout').click()
  await expect(modal(page).getByText('Выйти из аккаунта на этом устройстве?')).toBeVisible()
  await page.getByTestId('logout-confirm').click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(otherTab).toHaveURL(/\/login$/, { timeout: 10_000 })
  await otherTab.close()
  await expect(button(page, 'Войти')).toBeVisible({ timeout: 20_000 })

  await field(page, 'email').fill(email)
  await field(page, 'password').fill(PASSWORD)
  await button(page, 'Войти').click()
  await expect(page.getByTestId('form-error')).toHaveText('Неверная почта или пароль', { timeout: 20_000 })

  await signIn(page, email, nextPassword)
  await expect(page).toHaveURL(/\/home$/)

  // ── account deletion ─────────────────────────────────────────────────────
  await openProfile(page)
  await page.getByTestId('row-delete-account').click()
  await expect(pageTitle(page)).toHaveText('Удаление аккаунта')
  await expect(page.getByText('Это действие необратимо')).toBeVisible()
  await expect(page.getByTestId('consequences').getByRole('listitem')).toHaveCount(3)
  await expectNoHorizontalOverflow(page)
  await shot(page, 'web-delete-account')

  // Two confirmations in a row: the checkbox, then the dialog.
  const remove = page.getByTestId('delete-account')
  await expect(remove).toBeDisabled()
  await checkConsent(page)
  await expect(remove).toBeEnabled()
  await remove.click()
  await expect(modal(page).getByRole('heading', { name: 'Удалить аккаунт?' })).toBeVisible()
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByTestId('deleted-message')).toContainText('Аккаунт и все разговоры удалены', {
    timeout: 30_000,
  })
  await shot(page, 'web-deleted')
  await page.getByTestId('deleted-ok').click()

  // A deleted account no longer lets anyone in.
  await expect(page).toHaveURL(/\/login$/)
  await expect(button(page, 'Войти')).toBeVisible({ timeout: 20_000 })
  await field(page, 'email').fill(email)
  await field(page, 'password').fill(nextPassword)
  await button(page, 'Войти').click()
  await expect(page.getByTestId('form-error')).toBeVisible({ timeout: 20_000 })

  // Nothing on the way was blocked by the security policy (that includes the API origin).
  expect(await violations(), 'нарушения политики безопасности').toEqual([])
})

/**
 * The profile as a settings page: one centred column of sections with rows, each row the element
 * it should be (a link to go somewhere, a link to a new tab for a document, a button for an
 * action), and the two sub-pages with their way back. Nothing is changed for good here: the
 * account flow above does that.
 */
test('профиль: разделы, строки и подстраницы', async ({ page, shot }) => {
  test.setTimeout(120_000)
  await clearMailbox()
  await openWebApp(page)
  await registerAndConfirm(page, uniqueEmail('web-settings'))
  await openProfile(page)

  // ── the page: one h1 in the header, seven sections (the memory one shows while the agent has memory on; the mock agent has it
  // on), a column in the middle ──
  await expect(pageTitle(page)).toHaveCount(1)
  await expect(page).toHaveTitle('Профиль — Рядом')
  await expect(page.getByTestId('profile-name')).toHaveText('Тест')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 2 })).toHaveText([
    'Безопасность',
    'Память',
    'Поддержка',
    'Документы',
    'Голос агента',
    'Приложение',
    'Опасная зона',
  ])
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)

  const width = viewportWidth(page)
  const mainBox = (await main.boundingBox())!
  const row = (await page.getByTestId('row-change-password').boundingBox())!
  expect(row.width, 'колонка настроек читаемой ширины').toBeLessThanOrEqual(680)
  expect(row.height, 'строка настроек с запасом под палец').toBeGreaterThanOrEqual(44)
  if (isPhone(page)) {
    expect(row.x, 'строка с отступом слева').toBeGreaterThanOrEqual(8)
    expect(row.x + row.width, 'строка с отступом справа').toBeLessThanOrEqual(width - 8)
  } else {
    expect(
      Math.abs(row.x + row.width / 2 - (mainBox.x + mainBox.width / 2)),
      'колонка настроек по центру страницы',
    ).toBeLessThanOrEqual(2)
  }
  await shot(page, 'web-settings')

  // ── rows are the element they should be ──────────────────────────────────
  await expect(page.getByTestId('row-change-password')).toHaveAttribute('href', '/profile/change-password')
  await expect(page.getByTestId('row-people')).toHaveAttribute('href', '/people')
  for (const id of ['row-terms', 'row-privacy']) {
    await expect(page.getByTestId(id), id).toHaveAttribute('target', '_blank')
    await expect(page.getByTestId(id), id).toHaveAttribute('rel', /noopener/)
  }
  expect(await page.getByTestId('row-about').evaluate((element) => element.tagName)).toBe('BUTTON')
  await expect(
    page.getByRole('list', { name: 'Опасная зона' }).getByTestId('row-delete-account'),
    'удаление — в опасной зоне, а не среди обычных строк',
  ).toHaveAttribute('href', '/profile/delete')

  // ── actions that stay on the page ────────────────────────────────────────
  await page.getByTestId('row-about').click()
  await expect(modal(page).getByRole('heading', { name: 'О приложении' })).toBeVisible()
  await modalButton(page, 'ОК').click()
  await expect(modal(page)).toHaveCount(0)

  await page.getByTestId('edit-name').click()
  await expect(modal(page).getByRole('heading', { name: 'Имя' })).toBeVisible()
  await modal(page).locator('input[name="name"]').fill('')
  await page.getByTestId('name-save').click()
  await expect(page.getByTestId('form-error')).toBeVisible()
  await modalButton(page, 'Отмена').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(page.getByTestId('profile-name')).toHaveText('Тест')

  await page.getByTestId('logout').click()
  await expect(modal(page).getByRole('heading', { name: 'Выход' })).toBeVisible()
  await modalButton(page, 'Отмена').click()
  await expect(modal(page)).toHaveCount(0)
  await expect(page).toHaveURL(/\/profile$/)

  // ── sub-page: the password. It has the way back, and it checks before it asks the server ─
  await page.getByTestId('row-change-password').click()
  await expect(page).toHaveURL(/\/profile\/change-password$/)
  await expect(pageTitle(page)).toHaveText('Изменить пароль')
  await expect(page).toHaveTitle('Изменить пароль — Рядом')
  const back = main.getByRole('link', { name: 'Профиль', exact: true })
  await expect(back).toBeVisible()
  await field(page, 'current-password').fill(PASSWORD)
  await field(page, 'new-password').fill('another-Password-2')
  await field(page, 'repeat-password').fill('different-Password-3')
  await page.getByTestId('change-password-submit').click()
  await expect(page.getByTestId('form-error')).toHaveText('Пароли не совпадают')
  await expect(field(page, 'repeat-password')).toBeFocused()
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await back.click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(pageTitle(page)).toHaveText('Профиль')

  // ── sub-page: deletion. Two confirmations; here only the first one is toggled ─
  await page.getByTestId('row-delete-account').click()
  await expect(page).toHaveURL(/\/profile\/delete$/)
  await expect(pageTitle(page)).toHaveText('Удаление аккаунта')
  await expect(main.getByRole('heading', { level: 2, name: 'Что произойдёт' })).toBeVisible()
  await expect(page.getByTestId('consequences').getByRole('listitem')).toHaveCount(3)
  const remove = page.getByTestId('delete-account')
  await expect(remove).toBeDisabled()
  await checkConsent(page)
  await expect(remove).toBeEnabled()
  await page.getByTestId('consents').getByRole('checkbox').uncheck()
  await expect(remove).toBeDisabled()
  await expectSingleSos(page)
  await expectNoHorizontalOverflow(page)
  await main.getByRole('link', { name: 'Профиль', exact: true }).click()
  await expect(page).toHaveURL(/\/profile$/)
})

/**
 * An address that was registered and never confirmed is not taken (a lost code, a closed tab, or
 * someone parking a stranger's address): registering it again stores the new password and name and
 * sends a new code. After a refused code the next paste submits by itself.
 */
test('неподтверждённую почту можно зарегистрировать заново, а код после ошибки уходит сам', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const email = uniqueEmail('web-reregister')
  await clearMailbox()

  async function register(name: string, password: string): Promise<void> {
    await openWebApp(page, '/register')
    await dismissMemoryInvite(page) // the sheet "Рядом теперь запоминает важное" is not this test's subject
    await field(page, 'name').fill(name)
    await field(page, 'email').fill(email)
    await field(page, 'password').fill(password)
    await checkConsent(page)
    await button(page, 'Создать аккаунт').click()
    await expect(page.getByRole('heading', { name: 'Подтверди почту' })).toBeVisible({ timeout: 20_000 })
  }

  await register('Чужой', 'someone-elses-password')
  await waitForCode(email)
  await clearMailbox()

  // The first attempt is abandoned; the owner starts over with the same address.
  await register('Тест', PASSWORD)
  const code = await waitForCode(email)
  const codeField = page.getByRole('textbox', { name: 'Код из письма' })

  // A wrong code is refused with the field selected; the right one, pasted over it, goes by itself.
  await codeField.fill('000000')
  await expect(page.getByTestId('form-error')).toContainText('Код не подошёл', { timeout: 20_000 })
  await codeField.fill(code)
  await expect(talkButton(page)).toBeVisible({ timeout: 30_000 })
  // The account carries the owner's name and password, not the first registration's.
  await expect(page.getByTestId('home-greeting')).toContainText('Тест')
  await expect(page.getByTestId('home-greeting')).not.toContainText('Чужой')
})
