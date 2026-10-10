import { Block, Button, List, Navbar, Page, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState } from 'react'
import { ResetPasswordApiErrorCode } from '@ryadom/contracts/api/auth/reset-password'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import { apiErrorText, codeText, login, resetPassword } from '../../../lib/api'
import { useAuth } from '../../../lib/store'
import { passwordProblem } from '../../../lib/validation'
import CodeInput from '../../CodeInput'
import PasswordInput from '../../PasswordInput'

/**
 * Second step of a password change: the code and the new password in one form. On
 * success we sign the person in ourselves, since they have just set the password.
 */

const RESET_ERRORS: Record<ResetPasswordApiErrorCode, string> = {
  [ResetPasswordApiErrorCode.CODE_INVALID]: 'Код не подошёл. Проверь письмо или запроси новый',
  [ResetPasswordApiErrorCode.TOO_MANY_ATTEMPTS]: 'Слишком много попыток. Запроси новый код',
  [ResetPasswordApiErrorCode.USER_INACTIVE]: 'Аккаунт недоступен. Напиши нам, разберёмся',
}

export default function ResetPasswordPage({ f7router, email }: { f7router: Router.Router; email: string }) {
  const { login: storeLogin } = useAuth()
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    const invalid = (message: string) => {
      reportForm('reset_password', 'invalid')
      setError(message)
    }
    if (code.length !== 6) return invalid('Код — шесть цифр из письма')
    const problem = passwordProblem(password)
    if (problem) return invalid(problem)

    setError('')
    setLoading(true)
    let changed = false
    try {
      const result = await resetPassword(email, code, password)
      if (!result.ok) {
        reportForm('reset_password', outcomeFromCode(result.code))
        setError(codeText(RESET_ERRORS, result.code, 'Не получилось сменить пароль'))
        return
      }
      changed = true
      reportForm('reset_password', 'success')
      const { user, tokens } = await login(email, password)
      await storeLogin(user, tokens)
      f7.toast.create({ text: 'Пароль изменён', closeTimeout: 2000 }).open()
    } catch (err) {
      // After the password was changed a failure belongs to the sign-in that follows, not to this form.
      if (!changed) reportForm('reset_password', outcomeFromError(err))
      setError(
        apiErrorText(
          err,
          { byStatus: { 401: 'Пароль изменён, но войти не удалось. Попробуй на экране входа' } },
          'Не получилось сменить пароль',
        ),
      )
      if (err instanceof Error) f7router.navigate('/login/', { clearPreviousHistory: true })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page name="reset-password" className="rd-page-auth">
      <Navbar backLink="Назад" transparent />
      <div className="rd-auth-head">
        <h1 className="rd-title">Код и новый пароль</h1>
        <p className="rd-muted">
          Если аккаунт с адресом <b className="rd-email">{email}</b> есть, мы отправили код. Введи его и задай новый пароль.
        </p>
      </div>

      <CodeInput
        value={code}
        disabled={loading}
        onChange={(value) => {
          setCode(value)
          setError('')
        }}
      />

      <List form className="rd-form">
        <PasswordInput
          label="Новый пароль"
          name="new-password"
          value={password}
          autocomplete="new-password"
          info={`Не меньше ${InputLimit.PasswordMin} символов`}
          onChange={(value) => {
            setPassword(value)
            setError('')
          }}
        />
      </List>

      <Block className="rd-form-actions">
        {error && <p className="rd-form-error" data-testid="form-error">{error}</p>}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleSubmit()}>
          Сменить пароль
        </Button>
      </Block>
    </Page>
  )
}
