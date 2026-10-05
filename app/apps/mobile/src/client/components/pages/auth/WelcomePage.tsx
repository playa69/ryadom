import { Block, Button, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState } from 'react'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { apiErrorText, deviceLogin } from '../../../lib/api'
import { useAuth } from '../../../lib/store'
import { useEnvSwitcherTaps } from '../../../lib/use-env-switcher'
import { BrandMark } from '../../Brand'
import ConsentList, { NO_CONSENT, allConsented } from '../../ConsentList'

/**
 * The first screen. Someone new here sees what the service is, agrees to what it needs (being 18, the
 * disclaimer, the terms and the processing of personal data), and one press later is talking: an
 * account is made for this phone behind the scenes, with no address and no password to think of.
 * Registration by email is offered later, where it has something to give.
 *
 * The same screen is also the gate for someone who is already signed in but has not agreed to the
 * current version of the terms (an account from before this screen existed, or a newer version of the
 * terms): there it only records the agreement and goes on, and there is no account to make.
 */
export default function WelcomePage({ f7router }: { f7router: Router.Router }) {
  const { auth, login, acceptConsents } = useAuth()
  // Entry to the env picker (dev build): taps on the mark, reachable even when the server is down.
  const onLogoTap = useEnvSwitcherTaps()
  const [consent, setConsent] = useState(NO_CONSENT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const signedIn = auth.isAuthenticated

  async function handleStart() {
    if (!allConsented(consent)) {
      setError('Чтобы начать, нужны все три согласия')
      return
    }
    setError('')
    setLoading(true)
    try {
      if (signedIn) {
        // The app's gate sees the recorded version and moves on by itself.
        if (!(await acceptConsents())) setError('Не получилось сохранить согласие. Попробуй ещё раз')
      } else {
        const { user, tokens } = await deviceLogin()
        await login(user, tokens, { consent: true })
      }
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось начать. Попробуй ещё раз'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page name="welcome" className="rd-page-auth">
      <div className="rd-auth-head rd-auth-head--top">
        <div className="rd-auth-orb" aria-hidden="true" />
        <button type="button" className="rd-logo-button" onClick={onLogoTap} aria-label="Рядом">
          <BrandMark size={56} />
        </button>
        <h1 className="rd-title rd-title--lg">Рядом</h1>
        <p className="rd-muted">
          {signedIn
            ? 'Один раз подтверди, что согласен(на), — и можно говорить.'
            : 'Когда нужно, чтобы кто‑то был рядом. Поговорить можно сразу, без регистрации.'}
        </p>
      </div>

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
            onClick={() => f7router.navigate('/login/')}
            data-testid="have-account"
          >
            У меня уже есть аккаунт
          </Button>
        )}
        {!signedIn && (
          <p className="rd-fineprint">
            Без почты разговоры хранятся {ANONYMOUS_RETENTION_DAYS} дней после последнего визита. Привязать
            почту, чтобы их не потерять, можно в любой момент в профиле.
          </p>
        )}
      </Block>
    </Page>
  )
}
