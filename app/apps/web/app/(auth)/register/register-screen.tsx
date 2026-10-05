'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { RegisterApiErrorCode } from '@ryadom/contracts/api/auth/register'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { nameProblem, passwordProblem } from '@ryadom/client-core/validation'
import { useClient } from '@/lib/auth'
import { useAuthFlow } from '../auth-flow'
import { ConsentGroup, NO_CONSENT, allConsented, firstMissingConsent } from '../_components/consent-group'
import { PasswordField, TextField } from '../_components/fields'
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
 * Registration by email and password. No session is issued here: signing in opens up only after
 * the code from the email is entered, so on success the screen goes to code entry.
 *
 * The password is handed to the next step in memory: the person typed it a moment ago, and asking
 * again right after confirmation is a needless step. It is never stored.
 */

const REGISTER_ERRORS: Record<RegisterApiErrorCode, string> = {
  [RegisterApiErrorCode.USER_ALREADY_EXISTS]: 'С этой почтой уже есть аккаунт. Войди или смени пароль',
  [RegisterApiErrorCode.DISPOSABLE_EMAIL]: 'Такую почту мы не принимаем — укажи постоянный адрес',
}

const REGISTER_FALLBACK = 'Не получилось создать аккаунт. Попробуй ещё раз'

export default function RegisterScreen() {
  const client = useClient()
  const router = useRouter()
  const flow = useAuthFlow()
  const formRef = useRef<HTMLFormElement>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [consent, setConsent] = useState(NO_CONSENT)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  // Coming back from the code screen must not leave the old password in memory.
  const { clear } = flow
  useEffect(() => clear(), [clear])

  function refuse(text: string, field: string) {
    setProblem({ text, field })
    focusField(formRef.current, field)
  }

  async function submit() {
    if (loading) return
    const address = email.trim().toLowerCase()
    const nameError = nameProblem(name)
    if (nameError) return refuse(nameError, 'name')
    if (!address) return refuse('Введи почту и пароль', 'email')
    if (!password) return refuse('Введи почту и пароль', 'password')
    const passwordError = passwordProblem(password)
    if (passwordError) return refuse(passwordError, 'password')
    if (!allConsented(consent)) {
      return refuse('Без всех трёх согласий аккаунт не создать', firstMissingConsent(consent))
    }

    setProblem(null)
    setLoading(true)
    try {
      const result = await client.register(address, password, name.trim())
      if (!result.ok) {
        refuse(codeText(REGISTER_ERRORS, result.code, REGISTER_FALLBACK), 'email')
        return
      }
      // The agreement is recorded once the code is entered and the session starts: only then is there
      // an account to record it for.
      flow.begin('confirm', result.data.email, password, true)
      router.push('/confirm-email')
    } catch (err) {
      setProblem({
        text: apiErrorText(
          err,
          { byStatus: { 422: `Проверь почту, имя и пароль (от ${InputLimit.PasswordMin} символов)` } },
          REGISTER_FALLBACK,
        ),
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <BackLink href="/login" />
      <AuthHead title="Давай знакомиться">
        Аккаунт нужен, чтобы разговоры оставались твоими и не терялись.
      </AuthHead>

      <AuthForm formRef={formRef} onSubmit={() => void submit()}>
        <TextField
          label="Как тебя называть"
          name="name"
          type="text"
          value={name}
          maxLength={InputLimit.NameMax}
          autoComplete="given-name"
          autoCapitalize="words"
          required
          invalid={problem?.field === 'name'}
          focusOnFinePointer
          onChange={(value) => {
            setName(value)
            setProblem(null)
          }}
        />
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
          onChange={(value) => {
            setEmail(value)
            setProblem(null)
          }}
        />
        <PasswordField
          label="Пароль"
          name="password"
          value={password}
          autoComplete="new-password"
          hint={`Не меньше ${InputLimit.PasswordMin} символов`}
          required
          invalid={problem?.field === 'password'}
          onChange={(value) => {
            setPassword(value)
            setProblem(null)
          }}
        />

        {/* Consent is given explicitly: being 18+, the disclaimer, personal data processing (152-FZ). */}
        <ConsentGroup
          value={consent}
          invalid={problem?.field?.startsWith('consent') ?? false}
          onChange={(next) => {
            setConsent(next)
            setProblem(null)
          }}
          termsUrl={flow.termsUrl}
          privacyUrl={flow.privacyUrl}
        />

        <AuthActions>
          <FormError problem={problem} />
          <SubmitButton loading={loading}>Создать аккаунт</SubmitButton>
        </AuthActions>
      </AuthForm>
    </>
  )
}
