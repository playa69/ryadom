'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { MailIcon } from 'lucide-react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type FormOutcome } from '@ryadom/analytics/events'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { codeProblem } from '@ryadom/client-core/validation'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { useNotice } from '@/components/Notice'
import { codeOutcome, formOutcome, trackForm } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { useAuthFlow, useFlowEmail } from '../auth-flow'
import { CodeField } from '../_components/fields'
import {
  Address,
  AuthActions,
  AuthForm,
  AuthHead,
  BackLink,
  FinePrint,
  FormError,
  OUTLINE_BUTTON,
  SubmitButton,
  focusField,
  type Problem,
} from '../_components/parts'
import { useCooldown } from '../_components/use-cooldown'

/**
 * Email confirmation code entry. When the password came from the registration screen, we sign the
 * person in right after confirmation: they typed it a moment ago, so there is no reason to ask a
 * second time. After a reload the password is gone, and the person goes to the sign-in screen.
 */

const CONFIRM_ERRORS: Record<ConfirmEmailApiErrorCode, string> = {
  [ConfirmEmailApiErrorCode.CODE_INVALID]: 'Код не подошёл. Проверь письмо или запроси новый',
  [ConfirmEmailApiErrorCode.TOO_MANY_ATTEMPTS]: 'Слишком много попыток. Запроси новый код',
  [ConfirmEmailApiErrorCode.EMAIL_ALREADY_CONFIRMED]: 'Почта уже подтверждена — можно входить',
}

const RESEND_COOLDOWN_SEC = 60

export default function ConfirmEmailScreen() {
  const email = useFlowEmail('confirm', '/register')
  return email ? <ConfirmForm email={email} /> : null
}

function ConfirmForm({ email }: { email: string }) {
  const router = useRouter()
  const client = useClient()
  const { login } = useAuth()
  const { takePassword, takeConsent, clear } = useAuthFlow()
  const notify = useNotice()
  const formRef = useRef<HTMLFormElement>(null)
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const cooldown = useCooldown(RESEND_COOLDOWN_SEC)

  function refuse(text: string, outcome: FormOutcome = 'invalid') {
    trackForm('confirm_email', outcome)
    setProblem({ text, field: 'code' })
    const input = formRef.current?.elements.namedItem('code')
    if (input instanceof HTMLInputElement) {
      input.focus()
      // The next attempt replaces the wrong code instead of appending to it.
      input.select()
    }
  }

  async function submit(value: string) {
    if (loading) return
    const invalid = codeProblem(value)
    if (invalid) return refuse(invalid)

    setProblem(null)
    setLoading(true)
    try {
      const result = await client.confirmEmail(email, value)
      if (!result.ok) {
        refuse(
          codeText(CONFIRM_ERRORS, result.code, 'Не получилось подтвердить почту'),
          codeOutcome(result.code),
        )
        return
      }
      trackForm('confirm_email', 'success')
      const password = takePassword()
      const consented = takeConsent()
      clear()
      if (password) {
        try {
          // On success the (auth) frame sees the session and moves on to /home. The agreement given on
          // the registration screen is recorded on the way: the account exists now.
          await login(email, password, { consent: consented })
          return
        } catch {
          // The address is confirmed anyway; the sign-in screen is the way forward.
        }
      }
      notify('Почта подтверждена — можно входить', 'success')
      router.replace('/login')
    } catch (err) {
      trackForm('confirm_email', formOutcome(err))
      setProblem({ text: apiErrorText(err, {}, 'Не получилось подтвердить почту'), field: 'code' })
    } finally {
      setLoading(false)
    }
  }

  async function resend() {
    if (cooldown.remaining > 0) return
    cooldown.restart()
    // The old code stops working once a new one is sent.
    setCode('')
    setProblem(null)
    focusField(formRef.current, 'code')
    try {
      await client.resendConfirmation(email)
      track(AnalyticsEvent.EmailCodeResent, { form: 'confirm_email' })
      notify('Отправили новый код', 'success')
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось отправить письмо'), 'error')
    }
  }

  return (
    <>
      <BackLink href="/register" />
      <AuthHead title="Подтверди почту" badge={<MailIcon className="size-[30px]" strokeWidth={1.8} />}>
        Мы отправили код на <Address>{email}</Address>. Введи его&nbsp;— и можно начинать.
      </AuthHead>

      <AuthForm formRef={formRef} onSubmit={() => void submit(code)}>
        <CodeField
          value={code}
          readOnly={loading}
          invalid={problem?.field === 'code'}
          autoFocus
          onChange={(value) => {
            setCode(value)
            setProblem(null)
          }}
          onComplete={(value) => void submit(value)}
        />

        <AuthActions>
          <FormError problem={problem} />
          <SubmitButton loading={loading}>Подтвердить</SubmitButton>
          <Button
            type="button"
            variant="outline"
            className={cn(OUTLINE_BUTTON, 'disabled:shadow-none')}
            disabled={cooldown.remaining > 0}
            onClick={() => void resend()}
          >
            {cooldown.remaining > 0 ? `Отправить снова через ${cooldown.remaining} с` : 'Отправить код снова'}
          </Button>
        </AuthActions>
      </AuthForm>

      <FinePrint>Письма нет? Загляни в «Спам»&nbsp;— иногда оно попадает туда.</FinePrint>
    </>
  )
}
