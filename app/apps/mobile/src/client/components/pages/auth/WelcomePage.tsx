import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Block, Button, List, ListInput, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState, type ChangeEvent } from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import { apiErrorText, deviceLogin, telegramLogin, updateProfile } from '../../../lib/api'
import { useAuth } from '../../../lib/store'
import { isTelegramMiniApp, telegramFirstName, telegramInitData } from '../../../lib/telegram'
import { telegramLoginErrorText } from '../../../lib/telegram-account'
import { nameProblem } from '../../../lib/validation'
import { useEnvSwitcherTaps } from '../../../lib/use-env-switcher'
import { BrandMark } from '../../Brand'
import ConsentList, { NO_CONSENT, allConsented } from '../../ConsentList'
import { DIALOG_KEEP_NOTE, GUEST_LIFE_CLAUSE } from '@ryadom/client-core/retention'

/**
 * The first screen. Someone new here sees what the service is, agrees to what it needs (being 18, the
 * disclaimer, the terms and the processing of personal data), and one press later is talking: an
 * account is made for this phone behind the scenes, with no address and no password to think of.
 * Registration by email is offered later, where it has something to give.
 *
 * The same screen is also the gate for someone who is already signed in but has not agreed to the
 * current version of the terms (an account from before this screen existed, or a newer version of the
 * terms): there it only records the agreement and goes on, and there is no account to make.
 *
 * In the Telegram Mini App the account is made for the person's Telegram user instead of this phone,
 * and the name from their Telegram profile is offered for the agent to call them by: it is saved only
 * as it stands in the field when they press «Начать», so they can change it or clear it.
 */
export default function WelcomePage({ f7router }: { f7router: Router.Router }) {
  const { auth, login, acceptConsents, updateUser } = useAuth()
  // Entry to the env picker (dev build): taps on the mark, reachable even when the server is down.
  const onLogoTap = useEnvSwitcherTaps()
  const [consent, setConsent] = useState(NO_CONSENT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const signedIn = auth.isAuthenticated
  const telegram = isTelegramMiniApp()
  const [name, setName] = useState(() => (telegram ? telegramFirstName().slice(0, InputLimit.NameMax) : ''))
  const startForm = telegram ? 'telegram_start' : 'device_start'

  async function handleStart() {
    // Only the anonymous start is a form of its own; for a signed-in account this screen is the terms gate.
    if (!signedIn) {
      track(AnalyticsEvent.CtaClicked, {
        cta: telegram ? 'start_telegram' : 'start_anonymous',
        placement: 'welcome',
      })
    }
    if (!allConsented(consent)) {
      if (!signedIn) reportForm(startForm, 'invalid')
      setError('Чтобы начать, нужны все три согласия')
      return
    }
    const problem = telegram && !signedIn && name.trim() ? nameProblem(name) : null
    if (problem) {
      reportForm(startForm, 'invalid')
      setError(problem)
      return
    }
    setError('')
    setLoading(true)
    try {
      if (signedIn) {
        // The app's gate sees the recorded version and moves on by itself.
        if (!(await acceptConsents())) setError('Не получилось сохранить согласие. Попробуй ещё раз')
      } else if (telegram) {
        await startWithTelegram()
      } else {
        const { user, tokens } = await deviceLogin()
        await login(user, tokens, { consent: true })
        reportForm('device_start', 'success')
      }
    } catch (err) {
      if (!signedIn) reportForm(startForm, outcomeFromError(err))
      setError(apiErrorText(err, {}, 'Не получилось начать. Попробуй ещё раз'))
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

  return (
    <Page name="welcome" className="rd-page-auth ph-no-capture">
      <div className="rd-auth-head rd-auth-head--top">
        <div className="rd-auth-orb" aria-hidden="true" />
        <button type="button" className="rd-logo-button" onClick={onLogoTap} aria-label="Рядом">
          <BrandMark size={56} />
        </button>
        <h1 className="rd-title rd-title--lg">Рядом</h1>
        <p className="rd-muted">
          {signedIn
            ? 'Один раз подтверди, что согласен(на), — и можно говорить.'
            : telegram
              ? 'Когда нужно, чтобы кто‑то был рядом. Вход через твой Telegram — без почты и паролей.'
              : 'Когда нужно, чтобы кто‑то был рядом. Поговорить можно сразу, без регистрации.'}
        </p>
      </div>

      {telegram && !signedIn && (
        <List form className="rd-form" onSubmit={(event) => event.preventDefault()}>
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

      <ConsentList
        value={consent}
        onChange={(next) => {
          setConsent(next)
          setError('')
        }}
      />

      <Block className="rd-form-actions">
        {error && (
          <p className="rd-form-error" data-testid="form-error">
            {error}
          </p>
        )}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleStart()}>
          {signedIn ? 'Продолжить' : 'Начать'}
        </Button>
        {!signedIn && (
          <Button
            large
            outline
            disabled={loading}
            onClick={() => {
              track(AnalyticsEvent.CtaClicked, { cta: 'login', placement: 'welcome' })
              f7router.navigate('/login/')
            }}
            data-testid="have-account"
          >
            У меня уже есть аккаунт
          </Button>
        )}
        {!signedIn && !telegram && (
          <p className="rd-fineprint">
            {DIALOG_KEEP_NOTE} Без почты аккаунт {GUEST_LIFE_CLAUSE}. Привязать почту можно в любой момент в
            профиле.
          </p>
        )}
        {!signedIn && telegram && (
          <p className="rd-fineprint">
            Аккаунт привязан к твоему Telegram: разговоры не потеряются, и открыть их можно в Telegram на
            любом устройстве. Почту для входа вне Telegram можно добавить в профиле.
          </p>
        )}
      </Block>
    </Page>
  )
}
