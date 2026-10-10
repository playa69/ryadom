'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { apiErrorText } from '@ryadom/client-core/errors'
import { formOutcome, trackForm } from '@/lib/analytics'
import { useClient } from '@/lib/auth'
import { useAuthFlow } from '../auth-flow'
import { TextField } from '../_components/fields'
import {
  AuthActions,
  AuthForm,
  AuthHead,
  BackLink,
  FormError,
  SubmitButton,
  focusField,
  type Problem,
} from '../_components/parts'

/**
 * First step of a password change: the email. The response is identical for an existing and a
 * missing address, so the screen goes straight to code entry and promises nothing.
 */
export default function ForgotPasswordScreen() {
  const client = useClient()
  const router = useRouter()
  const flow = useAuthFlow()
  const formRef = useRef<HTMLFormElement>(null)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  // Back from the code screen to ask for a new code: the address is already known.
  const previous = flow.emailFor('reset')
  const { ready } = flow
  useEffect(() => {
    if (ready && previous) setEmail((current) => current || previous)
  }, [ready, previous])

  async function submit() {
    if (loading) return
    const address = email.trim().toLowerCase()
    if (!address) {
      trackForm('forgot_password', 'invalid')
      setProblem({ text: 'Напиши почту', field: 'email' })
      focusField(formRef.current, 'email')
      return
    }

    setProblem(null)
    setLoading(true)
    try {
      await client.requestPasswordReset(address)
      trackForm('forgot_password', 'success')
      // Coming back from the code screen with the same address is asking for a new code.
      if (address === previous) track(AnalyticsEvent.EmailCodeResent, { form: 'reset_password' })
      flow.begin('reset', address)
      router.push('/reset-password')
    } catch (err) {
      trackForm('forgot_password', formOutcome(err))
      setProblem({ text: apiErrorText(err, {}, 'Не получилось отправить код. Попробуй ещё раз') })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <BackLink href="/login" />
      <AuthHead title="Восстановим доступ">
        Напиши почту, на которую заведён аккаунт,&nbsp;— пришлём код для смены пароля.
      </AuthHead>

      <AuthForm formRef={formRef} onSubmit={() => void submit()}>
        <TextField
          label="Почта"
          name="email"
          type="email"
          value={email}
          autoComplete="email"
          inputMode="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          invalid={problem?.field === 'email'}
          focusOnFinePointer
          onChange={(value) => {
            setEmail(value)
            setProblem(null)
          }}
        />

        <AuthActions>
          <FormError problem={problem} />
          <SubmitButton loading={loading}>Прислать код</SubmitButton>
        </AuthActions>
      </AuthForm>
    </>
  )
}
