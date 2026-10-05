import { Block, BlockTitle, Button, Icon, List, ListItem, Navbar, Page, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { apiErrorText, getCurrentUser, updateProfile } from '../../../lib/api'
import { getVersionInfo } from '../../../lib/device'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { ENV_SWITCHER_TAPS } from '../../../lib/env'
import { openExternal, privacyUrl, termsUrl } from '../../../lib/links'
import { useAuth } from '../../../lib/store'
import { nameProblem } from '../../../lib/validation'

/**
 * Profile: who is signed in and renaming, the password, people nearby, the documents, the about
 * dialog (in a dev build seven taps on the version number open the env picker), sign-out and
 * account deletion.
 *
 * Deletion is visible here rather than hidden away in support: the stores require it (App Store
 * 5.1.1(v) and Google Play policy), and the spec promises erasing everything with one button.
 */
export default function ProfilePage({ f7router }: { f7router: Router.Router }) {
  const { auth, logout, leaveAnonymousAccount, updateUser } = useAuth()
  const [version, setVersion] = useState('')
  const [envTitle, setEnvTitle] = useState<string | null>(null)
  const versionTaps = useRef(0)
  const user = auth.user
  const userId = user?.id ?? null
  // An anonymous account has no address and no password; one that linked an address and has not
  // entered the code yet is waiting for the second step.
  const noEmail = user?.email === null
  const pendingEmail = user?.email && user.isEmailConfirmed === false ? user.email : null
  // Both are opened by this phone alone, so signing out is not a thing they have: leaving one is
  // going to another account, and it says what that costs.
  const anonymous = noEmail || pendingEmail !== null

  // The rest of the profile is fetched from the server: sign-in returns only the basic fields.
  useEffect(() => {
    if (!userId) return
    getCurrentUser()
      .then((me) =>
        updateUser({ email: me.email, name: me.name, isEmailConfirmed: me.isEmailConfirmed, createdAt: me.createdAt }),
      )
      .catch(() => {})
  }, [userId, updateUser])

  useEffect(() => {
    void getVersionInfo().then((info) =>
      setVersion(info.versionCode !== null ? `${info.versionName} (${info.versionCode})` : info.versionName),
    )
  }, [])

  useEffect(() => {
    // A literal in place: in a prod build this branch is stripped together with the switcher.
    if (import.meta.env.VITE_FLAVOR !== 'dev') return
    void import('../../../lib/env-switcher').then(({ describeEnv }) => setEnvTitle(describeEnv().title))
  }, [])

  // The env picker is hidden behind seven taps: such a menu item must not be shown even in a dev
  // build, because testers see it.
  function handleVersionTap(event: MouseEvent) {
    if (import.meta.env.VITE_FLAVOR !== 'dev') return
    event.stopPropagation()
    versionTaps.current += 1
    if (versionTaps.current < ENV_SWITCHER_TAPS) return
    versionTaps.current = 0
    void import('../../../lib/env-switcher').then(({ openEnvSwitcher }) => openEnvSwitcher(logout))
  }

  function handleEditName() {
    f7.dialog.prompt(
      'Как к тебе обращаться?',
      'Имя',
      (value: string) => {
        const problem = nameProblem(value)
        if (problem) {
          f7.toast.create({ text: problem, closeTimeout: 2000 }).open()
          return
        }
        void updateProfile({ name: value.trim() })
          .then((me) => {
            updateUser({ name: me.name })
            f7.toast.create({ text: 'Имя сохранено', closeTimeout: 1500 }).open()
          })
          .catch((error: unknown) => {
            f7.toast
              .create({ text: apiErrorText(error, {}, 'Не получилось сохранить имя'), closeTimeout: 2500 })
              .open()
          })
      },
      undefined,
      user?.name ?? '',
    )
  }

  function handleSwitchAccount() {
    f7.dialog.confirm(
      `Разговоры этого телефона в другой аккаунт не перенесутся. Вернуться в этот профиль будет нельзя, и через ${ANONYMOUS_RETENTION_DAYS} дней он удалится вместе с разговорами.`,
      'Войти в другой аккаунт',
      () => void leaveAnonymousAccount(),
    )
  }

  return (
    <Page name="profile">
      <Navbar title="Профиль" />

      <div className="rd-profile-head">
        <p className="rd-profile-name">{user?.name ?? (noEmail ? 'Гость' : '—')}</p>
        <p className="rd-profile-email">{noEmail ? 'Без регистрации' : (user?.email ?? '')}</p>
        <Button small round outline className="rd-profile-edit" onClick={handleEditName}>
          Изменить имя
        </Button>
      </div>

      {/* Sections and the sign-out/delete block are grid cells, so that from WIDE they stand in two
          columns (app.css); on a narrower screen they simply follow one another. */}
      <div className="rd-profile-grid">
      <section className="rd-profile-group">
      <BlockTitle>Аккаунт</BlockTitle>
      <List inset strong dividers className="rd-menu">
        {/* Direct children of the List, not a fragment: Framework7 groups the rows of a list by looking
            at them, and a fragment drops its rows out of the card. The explanation goes under the
            title: next to it (`after`) it is long enough to push the title out of the row. */}
        {noEmail && (
          <ListItem
            link
            title="Привязать почту"
            footer="чтобы войти с другого устройства"
            onClick={() => f7router.navigate('/profile/link-email/')}
          >
            <Icon slot="media" f7="envelope_fill" />
          </ListItem>
        )}
        {pendingEmail && (
          <ListItem
            link
            title="Подтвердить почту"
            footer={pendingEmail}
            onClick={() => f7router.navigate('/profile/link-email/', { props: { pendingEmail } })}
          >
            <Icon slot="media" f7="envelope_fill" />
          </ListItem>
        )}
        {!noEmail && (
          <ListItem link title="Изменить пароль" onClick={() => f7router.navigate('/profile/change-password/')}>
            <Icon slot="media" f7="lock_fill" />
          </ListItem>
        )}
        {anonymous && (
          <ListItem link title="Войти в другой аккаунт" onClick={handleSwitchAccount} data-testid="row-switch-account">
            <Icon slot="media" f7="arrow_right_square_fill" />
          </ListItem>
        )}
        <ListItem link title="Люди рядом" onClick={() => f7router.navigate('/people/')}>
          <Icon slot="media" f7="person_2_fill" />
        </ListItem>
      </List>
      {anonymous && (
        <Block>
          <p className="rd-caption">
            Без подтверждённой почты аккаунт хранится {ANONYMOUS_RETENTION_DAYS} дней после последнего визита, потом
            удаляется вместе с разговорами. Почта нужна и для входа с другого устройства.
          </p>
        </Block>
      )}
      </section>

      <section className="rd-profile-group">
      <BlockTitle>Приложение</BlockTitle>
      <List inset strong dividers className="rd-menu">
        <ListItem
          link
          title="О приложении"
          onClick={() =>
            f7.dialog.alert(
              `«Рядом»&nbsp;— сервис самоподдержки, не медицинская услуга и не психотерапия.<br><br>Версия ${version}`,
              'О приложении',
            )
          }
        >
          <Icon slot="media" f7="info_circle_fill" />
          {/* The version number counts the taps, not the whole row, or the dialog would open on each one. */}
          <span slot="after" onClick={handleVersionTap}>
            {version}
          </span>
        </ListItem>
        {envTitle && (
          <ListItem title="Среда" after={envTitle}>
            <Icon slot="media" f7="antenna_radiowaves_left_right" />
          </ListItem>
        )}
      </List>
      </section>

      <section className="rd-profile-group">
      <BlockTitle>Документы</BlockTitle>
      <List inset strong dividers className="rd-menu">
        <ListItem link title="Условия использования" onClick={() => void openExternal(termsUrl())}>
          <Icon slot="media" f7="doc_text_fill" />
        </ListItem>
        <ListItem
          link
          className="rd-wrap"
          title="Политика обработки персональных данных"
          onClick={() => void openExternal(privacyUrl())}
        >
          <Icon slot="media" f7="lock_shield_fill" />
        </ListItem>
      </List>
      </section>

      <div className="rd-profile-actions">
        {!anonymous && (
          <Block>
            <Button
              large
              outline
              className="rd-signout"
              onClick={() => f7.dialog.confirm('Выйти из аккаунта на этом устройстве?', 'Выход', () => void logout())}
            >
              Выйти из аккаунта
            </Button>
          </Block>
        )}

        <List inset strong className="rd-menu">
          <ListItem
            link
            title="Стереть всё и удалить аккаунт"
            className="rd-danger"
            onClick={() => f7router.navigate('/profile/delete/')}
          >
            <Icon slot="media" f7="trash_fill" />
          </ListItem>
        </List>
        <Block>
          <p className="rd-caption">
            Удаление необратимо: разговоры, память и профиль стираются, аккаунт тоже. Восстановить нельзя.
          </p>
        </Block>
      </div>
      </div>
    </Page>
  )
}
