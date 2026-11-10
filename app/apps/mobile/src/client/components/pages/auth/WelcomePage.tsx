import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Button, List, ListInput, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState, type ChangeEvent } from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import { apiErrorText, deviceLogin, telegramLogin, updateProfile } from '../../../lib/api'
import { requestTalkOnHome, takeTalkRequest } from '../../../lib/nav'
import { useAuth } from '../../../lib/store'
import { isTelegramMiniApp, telegramFirstName, telegramInitData } from '../../../lib/telegram'
import { telegramLoginErrorText } from '../../../lib/telegram-account'
import { nameProblem } from '../../../lib/validation'
import { useEnvSwitcherTaps } from '../../../lib/use-env-switcher'
import { SHORT_QUERY, useMediaQuery, WIDE_QUERY } from '../../../lib/viewport'
import { unlockSpeech } from '../../../lib/voice/speech'
import { BrandMark } from '../../Brand'
import Breathing from '../../Breathing'
import ConsentNote from '../../ConsentNote'
import { SosButton } from '../../SosSheet'
import Switch from '../../Switch'
import MemoryConsentSheet from '../profile/MemoryConsentSheet'
import { DIALOG_KEEP_NOTE, GUEST_LIFE_CLAUSE } from '@ryadom/client-core/retention'

function partOfDay(): string {
  const hour = new Date().getHours()
  return hour < 5 ? 'Поздний вечер' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
}

/**
 * The first screen. Someone new meets home itself: SOS, the breathing circle, «Поговорить» with the
 * optional memory choice, and at the foot what starting means, in view without scrolling (the lines of
 * help are behind SOS). The press is the agreement: it makes an account for this phone behind the
 * scenes, records the consents and asks home for a conversation with these choices, which home starts as
 * soon as the tabs appear; the companion greets the person there. Nothing is sent before that press.
 *
 * The same screen is also the gate for someone who is already signed in but has not agreed to the
 * current version of the terms (an account from before this screen existed, or a newer version of the
 * terms): there it only records the agreement on «Продолжить» and goes on, and there is no account to make.
 *
 * In the Telegram Mini App the account is made for the person's Telegram user instead of this phone,
 * and the name from their Telegram profile is offered for the agent to call them by: it is saved only
 * as it stands in the field when they press «Поговорить», so they can change it or clear it.
 */
export default function WelcomePage({ f7router }: { f7router: Router.Router }) {
  const { auth, login, acceptConsents, updateUser } = useAuth()
  // Entry to the env picker (dev build): taps on the mark, reachable even when the server is down.
  const onLogoTap = useEnvSwitcherTaps()
  const isWide = useMediaQuery(WIDE_QUERY)
  const isShort = useMediaQuery(SHORT_QUERY)
  const [hello] = useState(partOfDay)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const signedIn = auth.isAuthenticated
  const telegram = isTelegramMiniApp()
  const [name, setName] = useState(() => (telegram ? telegramFirstName().slice(0, InputLimit.NameMax) : ''))
  const startForm = telegram ? 'telegram_start' : 'device_start'
  /** "Запоминать важное" with the consent sheet accepted: home turns memory on before the conversation. */
  const [rememberMemory, setRememberMemory] = useState(false)
  const [memoryConsentOpen, setMemoryConsentOpen] = useState(false)
  const talkRequest = () => ({ rememberMemory })

  async function handleTalk() {
    if (loading) return
    // The conversation opens on the voice and the sphere speaks first: speech is let through by this tap.
    unlockSpeech()
    track(AnalyticsEvent.CtaClicked, {
      cta: telegram ? 'start_telegram' : 'start_anonymous',
      placement: 'welcome',
    })
    const problem = telegram && name.trim() ? nameProblem(name) : null
    if (problem) {
      reportForm(startForm, 'invalid')
      setError(problem)
      return
    }
    setError('')
    setLoading(true)
    try {
      if (telegram) {
        await startWithTelegram()
      } else {
        const { user, tokens } = await deviceLogin()
        // Asked before the session starts: home appears with the tabs and takes it at once.
        requestTalkOnHome(talkRequest())
        await login(user, tokens, { consent: true })
        reportForm('device_start', 'success')
      }
    } catch (err) {
      takeTalkRequest()
      reportForm(startForm, outcomeFromError(err))
      setError(apiErrorText(err, {}, 'Не получилось начать разговор. Попробуй ещё раз'))
    } finally {
      setLoading(false)
    }
  }

  async function startWithTelegram() {
    const outcome = await telegramLogin(telegramInitData() ?? '', true)
    if (!outcome.ok) {
      reportForm('telegram_start', outcomeFromCode(outcome.code))
      setError(telegramLoginErrorText(outcome.code))
      return
    }
    const { user, tokens } = outcome.data
    requestTalkOnHome(talkRequest())
    await login(user, tokens, { consent: true })
    reportForm('telegram_start', 'success')
    // A name the account already has (the person came back after signing out) is theirs: it stays.
    const chosen = name.trim()
    if (chosen && user.name === null) {
      await updateProfile({ name: chosen })
        .then((me) => updateUser({ name: me.name }))
        .catch(() => {
          // The name can be set later in the profile; the conversation does not wait for it.
        })
    }
  }

  async function handleAgree() {
    if (loading) return
    setError('')
    setLoading(true)
    // The app's gate sees the recorded version and moves on by itself.
    if (!(await acceptConsents())) setError('Не получилось сохранить согласие. Попробуй ещё раз')
    setLoading(false)
  }

  return (
    <Page name="welcome" className="rd-page-auth ph-no-capture">
      {/* Where it is on home: the way to help in danger needs no account. */}
      <SosButton slot="fixed" source="home" />
      <div className="rd-welcome-top">
        <button type="button" className="rd-logo-button" onClick={onLogoTap} aria-label="Рядом">
          <BrandMark size={36} />
        </button>
        {!signedIn && (
          <Button
            small
            outline
            round
            className="rd-welcome-login"
            disabled={loading}
            onClick={() => {
              track(AnalyticsEvent.CtaClicked, { cta: 'login', placement: 'welcome' })
              f7router.navigate('/login/')
            }}
            data-testid="have-account"
          >
            Войти
          </Button>
        )}
      </div>

      <div className="rd-home">
        <div className="rd-home-orb">
          <Breathing size={isWide ? 280 : isShort ? 140 : 176} />
        </div>
        <div className="rd-home-main">
          <p className="rd-home-greeting">{hello}</p>
          <p className="rd-muted rd-home-lead">
            {signedIn
              ? 'Один раз подтверди, что согласен(на), — и можно говорить.'
              : 'Я здесь и никуда не спешу. О чём хочется сказать?'}
          </p>

          {telegram && !signedIn && (
            <List form className="rd-form rd-welcome-name" onSubmit={(event) => event.preventDefault()}>
              <ListInput
                label="Как к тебе обращаться"
                name="name"
                type="text"
                value={name}
                outline
                floatingLabel
                clearButton
                autocomplete="given-name"
                maxlength={InputLimit.NameMax}
                info="Можно оставить пустым и указать позже в профиле"
                onInput={(event: ChangeEvent<HTMLInputElement>) => {
                  setName(event.target.value)
                  setError('')
                }}
                data-testid="welcome-name"
              />
            </List>
          )}

          <div className="rd-talk">
            {error && (
              <p className="rd-form-error" data-testid="form-error">
                {error}
              </p>
            )}
            <Button
              fill
              large
              preloader
              loading={loading}
              disabled={loading}
              onClick={() => void (signedIn ? handleAgree() : handleTalk())}
              data-testid="welcome-talk"
            >
              {signedIn ? 'Продолжить' : 'Поговорить'}
            </Button>
            {signedIn && <ConsentNote action="Продолжить" />}
            {/* The same optional choices as on home; neither is needed to start. */}
            {!signedIn && (
              <>
                <div className="rd-incognito" data-testid="memory-switch">
                  <span className="rd-incognito-text">
                    <span className="rd-incognito-title">Запоминать важное</span>
                    <span className="rd-caption">
                      {rememberMemory
                        ? 'Включится с первым разговором; выключить можно в профиле'
                        : 'Чтобы не начинать каждый раз с нуля. По желанию'}
                    </span>
                  </span>
                  {/* Remounted when the sheet opens or closes: a declined consent puts the switch back. */}
                  <Switch
                    key={String(memoryConsentOpen)}
                    checked={rememberMemory}
                    onChange={(on) => (on ? setMemoryConsentOpen(true) : setRememberMemory(false))}
                  />
                </div>
              </>
            )}
          </div>

          {/* The foot of the screen: what the first press agrees to, then how long things are kept. */}
          <div className="rd-welcome-foot" data-testid="welcome-foot">
            {!signedIn && <ConsentNote />}
            <p className="rd-fineprint rd-welcome-sos">В опасной ситуации звони 112.</p>
            {!signedIn && !telegram && (
              <p className="rd-fineprint">
                {DIALOG_KEEP_NOTE} Без почты аккаунт {GUEST_LIFE_CLAUSE}. Привязать почту можно в любой момент
                в профиле.
              </p>
            )}
            {!signedIn && telegram && (
              <p className="rd-fineprint">
                Аккаунт привязан к твоему Telegram, и открыть его можно в Telegram на любом устройстве.{' '}
                {DIALOG_KEEP_NOTE} Почту для входа вне Telegram можно добавить в профиле.
              </p>
            )}
          </div>
        </div>
      </div>

      <MemoryConsentSheet
        opened={memoryConsentOpen}
        kind="consent"
        busy={false}
        error=""
        onAccept={() => {
          // Nothing to record yet: the account is made by «Поговорить», and memory is turned on then.
          setRememberMemory(true)
          setMemoryConsentOpen(false)
        }}
        onClose={() => setMemoryConsentOpen(false)}
      />
    </Page>
  )
}
