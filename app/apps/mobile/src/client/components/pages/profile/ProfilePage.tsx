import ProfileSelfCheck from './ProfileSelfCheck'
import { setAnalyticsOptOut, track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { useAnalyticsOptOut } from '@ryadom/analytics/react'
import { Block, BlockTitle, Button, Icon, List, ListItem, Navbar, Page, Toggle, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { memoryInUse, memorySectionStatus } from '@ryadom/client-core/memory'
import { apiErrorText, getCurrentUser, getMemory, updateProfile } from '../../../lib/api'
import { getVersionInfo } from '../../../lib/device'
import { DEFAULT_AGENT_VOICE, type AgentVoice } from '@ryadom/contracts/api/auth/me'
import { DEFAULT_VOICE_ID, SBER_VOICE, findVoice } from '@ryadom/contracts/voices'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { ENV_SWITCHER_TAPS } from '../../../lib/env'
import { openExternal, privacyUrl, termsUrl } from '../../../lib/links'
import { useAuth } from '../../../lib/store'
import { HANDS_FREE_KEY, readHandsFree, writeHandsFree } from '../../../lib/voice/hands-free'
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
  /**
   * The section "Память": shown once the server has answered, not at all when that cannot be learnt.
   * Only a word is kept, never the facts.
   * Read again whenever the profile comes into view: the memory screen above it changes the answer.
   */
  const [memorySection, setMemorySection] = useState<{ status: string } | null>(null)
  const loadMemorySection = useCallback(() => {
    if (!userId) return
    getMemory()
      .then((memory) => {
        setMemorySection({ status: memorySectionStatus(memory) })
        updateUser({ memoryEnabled: memoryInUse(memory) })
      })
      .catch(() => setMemorySection(null))
  }, [userId, updateUser])

  useEffect(() => {
    loadMemorySection()
  }, [loadMemorySection])
  // The voice the agent speaks with; it is saved on the account and applies from the next conversation.
  const voice: AgentVoice = user?.voice ?? DEFAULT_AGENT_VOICE
  // On the Sber path its one voice speaks whatever was chosen, so that is the voice to name.
  const voiceShown =
    user?.voicePipeline === 'sber' ? SBER_VOICE : findVoice(user?.voiceName ?? DEFAULT_VOICE_ID[voice])
  // Hands-free belongs to this device, not the account: it applies from the next conversation.
  const [handsFree, setHandsFree] = useState(() => readHandsFree(HANDS_FREE_KEY))
  // Reporting of taps and counts is on until the person turns it off; this device only, like hands-free.
  const analyticsOptedOut = useAnalyticsOptOut()
  // An anonymous account has no address and no password; one that linked an address and has not
  // entered the code yet is waiting for the second step.
  const noEmail = user?.email === null
  const pendingEmail = user?.email && user.isEmailConfirmed === false ? user.email : null
  // An account with Telegram opens from the Mini App on any device: it has a way back in, so it is not a guest.
  const telegram = user?.telegramLinked === true
  // Both are opened by this phone alone, so signing out is not a thing they have: leaving one is
  // going to another account, and it says what that costs.
  const anonymous = (noEmail || pendingEmail !== null) && !telegram

  // The rest of the profile is fetched from the server: sign-in returns only the basic fields.
  useEffect(() => {
    if (!userId) return
    getCurrentUser()
      .then((me) =>
        updateUser({
          email: me.email,
          name: me.name,
          isEmailConfirmed: me.isEmailConfirmed,
          telegramLinked: me.telegramLinked,
          createdAt: me.createdAt,
          voice: me.voice,
          voiceName: me.voiceName,
          voicePipeline: me.voicePipeline,
        }),
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

  /**
   * The choice about analytics belongs to the account: the server keeps it and then reports nothing about the
   * person from any device. Turning it off takes effect here at once and the account is told afterwards (a
   * failure is retried at the next sign-in). Turning it back on goes the other way round: the account first,
   * and the device starts reporting only once the account has agreed, so a failed call cannot leave the two
   * disagreeing.
   */
  async function changeAnalytics(optOut: boolean) {
    if (optOut) {
      setAnalyticsOptOut(true)
      await updateProfile({ analyticsOptOut: true }).catch(() => {})
      return
    }
    try {
      await updateProfile({ analyticsOptOut: false })
      setAnalyticsOptOut(false)
    } catch (error) {
      f7.toast
        .create({
          text: apiErrorText(error, {}, 'Не получилось включить. Попробуй чуть позже'),
          closeTimeout: 2500,
        })
        .open()
    }
  }

  function handleSwitchAccount() {
    f7.dialog.confirm(
      `Разговоры этого телефона в другой аккаунт не перенесутся. Вернуться в этот профиль будет нельзя, и через ${ANONYMOUS_RETENTION_DAYS} дней он удалится вместе с разговорами.`,
      'Войти в другой аккаунт',
      () => void leaveAnonymousAccount(),
    )
  }

  return (
    <Page
      name="profile"
      className="ph-no-capture"
      onPageTabShow={loadMemorySection}
      onPageAfterIn={loadMemorySection}
    >
      <Navbar title="Профиль" />

      <div className="rd-profile-head">
        <p className="rd-profile-name">{user?.name ?? (noEmail ? 'Гость' : '—')}</p>
        <p className="rd-profile-email">
          {noEmail ? (telegram ? 'Вход через Telegram' : 'Без регистрации') : (user?.email ?? '')}
        </p>
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
                footer={telegram ? 'чтобы входить и вне Telegram' : 'чтобы войти с другого устройства'}
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
              <ListItem
                link
                title="Изменить пароль"
                onClick={() => f7router.navigate('/profile/change-password/')}
              >
                <Icon slot="media" f7="lock_fill" />
              </ListItem>
            )}
            {/* A guest has one phone and no way in from another, so there is no list to look at. */}
            {!anonymous && (
              <ListItem
                link
                title="Устройства и сессии"
                data-testid="row-sessions"
                onClick={() => f7router.navigate('/profile/sessions/')}
              >
                <Icon slot="media" f7="device_laptop" />
              </ListItem>
            )}
            {anonymous && (
              <ListItem
                link
                title="Войти в другой аккаунт"
                onClick={handleSwitchAccount}
                data-testid="row-switch-account"
              >
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
                Без подтверждённой почты аккаунт хранится {ANONYMOUS_RETENTION_DAYS} дней после последнего
                визита, потом удаляется вместе с разговорами. Почта нужна и для входа с другого устройства.
              </p>
            </Block>
          )}
        </section>

        {memorySection && (
          <section className="rd-profile-group" data-testid="memory-section">
            <BlockTitle>Память</BlockTitle>
            <List inset strong className="rd-menu">
              <ListItem
                link
                title="Что я помню"
                after={memorySection.status}
                data-testid="row-memory"
                onClick={() => f7router.navigate('/profile/memory/')}
              >
                <Icon slot="media" f7="sparkles" />
              </ListItem>
            </List>
            <Block>
              <p className="rd-caption">
                Важное из наших разговоров, чтобы не начинать с нуля. Включается только по твоему желанию.
              </p>
            </Block>
          </section>
        )}

        <section className="rd-profile-group" data-testid="voice-section">
          <BlockTitle>Голос агента</BlockTitle>
          <List inset strong className="rd-menu">
            <ListItem
              link
              title="Голос"
              after={voiceShown?.name}
              data-testid="voice-name"
              onClick={() => f7router.navigate('/profile/voice/')}
            />
          </List>
          <Block>
            <p className="rd-caption">Применится со следующего разговора и на всех твоих устройствах.</p>
          </Block>
          <List inset strong className="rd-menu">
            <ListItem title="Разговор без рук" data-testid="hands-free">
              <Toggle
                slot="after"
                checked={handsFree}
                onToggleChange={(on: boolean) => {
                  writeHandsFree(HANDS_FREE_KEY, on)
                  setHandsFree(on)
                  track(AnalyticsEvent.HandsFreeToggled, { enabled: on })
                }}
              />
            </ListItem>
          </List>
          <Block>
            <p className="rd-caption">
              Просто говори: шар сам поймёт, когда ты закончил(а), и замолчит, если заговорить поверх.
              Выключи, чтобы говорить по нажатию. Только на этом устройстве.
            </p>
          </Block>
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
            <ListItem title="Помогать улучшать «Рядом»" data-testid="analytics-toggle">
              <Toggle
                slot="after"
                checked={!analyticsOptedOut}
                onToggleChange={(on: boolean) => void changeAnalytics(!on)}
              />
            </ListItem>
          </List>
          <Block>
            <p className="rd-caption">
              Мы собираем обезличенные сведения о том, как работает «Рядом»: какие экраны открывают, куда
              нажимают, где бывают ошибки. Имени, почты и того, что ты говоришь и пишешь, там нет. Выбор
              относится ко всему аккаунту, на всех твоих устройствах.
            </p>
          </Block>
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

        <ProfileSelfCheck />

        <div className="rd-profile-actions">
          {!anonymous && (
            <Block>
              <Button
                large
                outline
                className="rd-signout"
                onClick={() =>
                  f7.dialog.confirm('Выйти из аккаунта на этом устройстве?', 'Выход', () => void logout())
                }
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
