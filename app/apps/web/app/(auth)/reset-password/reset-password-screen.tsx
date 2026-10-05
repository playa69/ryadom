'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { ResetPasswordApiErrorCode } from '@ryadom/contracts/api/auth/reset-password'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { codeProblem, passwordProblem } from '@ryadom/client-core/validation'
import { useNotice } from '@/components/Notice'
import { useAuth, useClient } from '@/lib/auth'
import { useAuthFlow, useFlowEmail } from '../auth-flow'
import { CodeField, PasswordField } from '../_components/fields'
import {
  Address,
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
 * Second step of a password change: the code and the new password in one form. On success we sign
 * the person in ourselves, since they have just set the password.
 */

const RESET_ERRORS: Record<ResetPasswordApiErrorCode, string> = {
  [ResetPasswordApiErrorCode.CODE_INVALID]: 'Код не подошёл. Проверь письмо или запроси новый',
  [ResetPasswordApiErrorCode.TOO_MANY_ATTEMPTS]: 'Слишком много попыток. Запроси новый код',
  [ResetPasswordApiErrorCode.USER_INACTIVE]: 'Аккаунт недоступен. Напиши нам, разберёмся',
}

const SIGN_IN_FAILED = 'Пароль изменён, но войти не удалось. Попробуй на экране входа'

export default function ResetPasswordScreen() {
  const email = useFlowEmail('reset', '/forgot-password')
  return email ? <ResetForm email={email} /> : null
}

function ResetForm({ email }: { email: string }) {
  const router = useRouter()
  const client = useClient()
  const { login } = useAuth()
  const { clear } = useAuthFlow()
  const notify = useNotice()
  const formRef = useRef<HTMLFormElement>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  function refuse(text: string, field: string) {
    setProblem({ text, field })
    focusField(formRef.current, field)
  }

  async function submit() {
    if (loading) return
    const codeError = codeProblem(code)
    if (codeError) return refuse(codeError, 'code')
    const passwordError = passwordProblem(password)
    if (passwordError) return refuse(passwordError, 'new-password')

    setProblem(null)
    setLoading(true)
    let changed = false
    try {
      const result = await client.resetPassword(email, code, password)
      if (!result.ok) {
        refuse(codeText(RESET_ERRORS, result.code, 'Не получилось сменить пароль'), 'code')
        return
      }
      changed = true
      clear()
      // On success the (auth) frame sees the session and moves on to /home.
      await login(email, password)
      notify('Пароль изменён', 'success')
    } catch (err) {
      if (changed) {
        // The password is already new; what failed is only the automatic sign-in.
        notify(SIGN_IN_FAILED, 'info')
        router.replace('/login')
      } else {
        setProblem({ text: apiErrorText(err, {}, 'Не получилось сменить пароль') })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <BackLink href="/forgot-password" />
      <AuthHead title="Код и новый пароль">
        Если аккаунт с адресом <Address>{email}</Address> есть, мы отправили код. Введи его и задай новый
        пароль.
      </AuthHead>

      <AuthForm formRef={formRef} onSubmit={() => void submit()}>
        <CodeField
          value={code}
          readOnly={loading}
          invalid={problem?.field === 'code'}
          autoFocus
          onChange={(value) => {
            setCode(value)
            setProblem(null)
          }}
          // The code is complete: the password is the next thing to type.
          onComplete={() => focusField(formRef.current, 'new-password')}
        />
        <PasswordField
          label="Новый пароль"
          name="new-password"
          value={password}
          autoComplete="new-password"
          hint={`Не меньше ${InputLimit.PasswordMin} символов`}
          required
          invalid={problem?.field === 'new-password'}
          onChange={(value) => {
            setPassword(value)
            setProblem(null)
          }}
        />

        <AuthActions>
          <FormError problem={problem} />
          <SubmitButton loading={loading}>Сменить пароль</SubmitButton>
        </AuthActions>
      </AuthForm>
    </>
  )
}
