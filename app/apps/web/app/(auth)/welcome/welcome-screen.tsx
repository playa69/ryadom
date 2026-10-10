'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { ANONYMOUS_RETENTION_DAYS, POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { apiErrorText } from '@ryadom/client-core/errors'
import { Button } from '@ryadom/ui/components/button'
import { formOutcome, trackForm } from '@/lib/analytics'
import { useAuth } from '@/lib/auth'
import { useAuthFlow } from '../auth-flow'
import { ConsentGroup, NO_CONSENT, allConsented, firstMissingConsent } from '../_components/consent-group'
import {
  AuthActions,
  AuthForm,
  AuthHead,
  FinePrint,
  FormError,
  OUTLINE_BUTTON,
  SubmitButton,
  focusField,
  type Problem,
} from '../_components/parts'

/**
 * The first screen. Someone new here sees what the service is, agrees to what it needs (being 18, the
 * disclaimer, the terms and the processing of personal data), and one press later is talking: an
 * account is made for this device behind the scenes, with no address and no password to think of.
 * Registration by email is offered later, where it has something to give.
 *
 * The same screen is also the gate for someone who is already signed in but has not agreed to the
 * current version of the terms (an account from before this screen existed, or a newer version of the
 * terms): there it only records the agreement and goes on, and there is no account to make.
 */
export default function WelcomeScreen() {
  const { status, user, startAnonymously, acceptConsents } = useAuth()
  const { termsUrl, privacyUrl } = useAuthFlow()
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [consent, setConsent] = useState(NO_CONSENT)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const signedIn = status === 'authenticated'

  // Agreed already (this screen just recorded it, or another tab did): nothing is left to ask.
  const agreed = signedIn && user?.consentVersion === POLICY_VERSION
  useEffect(() => {
    if (agreed) router.replace('/home')
  }, [agreed, router])

  async function submit() {
    if (loading) return
    // Signed in, this screen only records the agreement (the server reports it); the start is for newcomers.
    if (!signedIn) track(AnalyticsEvent.CtaClicked, { cta: 'start_anonymous', placement: 'welcome' })
    if (!allConsented(consent)) {
      if (!signedIn) trackForm('device_start', 'invalid')
      setProblem({ text: 'Чтобы начать, нужны все три согласия', field: firstMissingConsent(consent) })
      focusField(formRef.current, firstMissingConsent(consent))
      return
    }

    setProblem(null)
    setLoading(true)
    try {
      if (signedIn) {
        // The (auth) frame is not what moves on here: the effect above sees the recorded version.
        if (!(await acceptConsents()))
          setProblem({ text: 'Не получилось сохранить согласие. Попробуй ещё раз' })
      } else {
        // On success the (auth) frame sees the session and moves on to /home.
        await startAnonymously({ consent: true })
        trackForm('device_start', 'success')
      }
    } catch (err) {
      if (!signedIn) trackForm('device_start', formOutcome(err))
      setProblem({ text: apiErrorText(err, {}, 'Не получилось начать. Попробуй ещё раз') })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <AuthHead title="Добро пожаловать" hideTitle>
        {signedIn
          ? 'Один раз подтверди, что согласен(на), — и можно говорить.'
          : 'Когда нужно, чтобы кто-то был рядом. Поговорить можно сразу, без регистрации.'}
      </AuthHead>

      <AuthForm formRef={formRef} onSubmit={() => void submit()}>
        <ConsentGroup
          value={consent}
          onChange={(next) => {
            setConsent(next)
            setProblem(null)
          }}
          termsUrl={termsUrl}
          privacyUrl={privacyUrl}
          invalid={problem?.field !== undefined}
        />

        <AuthActions>
          <FormError problem={problem} />
          <SubmitButton loading={loading}>{signedIn ? 'Продолжить' : 'Начать'}</SubmitButton>
          {!signedIn && (
            <Button asChild variant="outline" className={OUTLINE_BUTTON}>
              <Link
                href="/login"
                data-testid="have-account"
                onClick={() => track(AnalyticsEvent.CtaClicked, { cta: 'login', placement: 'welcome' })}
              >
                У меня уже есть аккаунт
              </Link>
            </Button>
          )}
        </AuthActions>
      </AuthForm>

      {!signedIn && (
        <FinePrint>
          Без почты разговоры хранятся {ANONYMOUS_RETENTION_DAYS} дней после последнего визита. Привязать
          почту, чтобы их не потерять, можно в любой момент в профиле.
        </FinePrint>
      )}
    </>
  )
}
