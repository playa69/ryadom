import { Block, Button, List, Navbar, Page, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState } from 'react'
import { ChangePasswordApiErrorCode } from '@ryadom/contracts/api/auth/password'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import { apiErrorText, changePassword, codeText } from '../../../lib/api'
import { passwordProblem } from '../../../lib/validation'
import PasswordInput from '../../PasswordInput'

/** Password change that requires the current password. */

const CHANGE_PASSWORD_ERRORS: Record<ChangePasswordApiErrorCode, string> = {
  [ChangePasswordApiErrorCode.INVALID_CURRENT_PASSWORD]: 'Текущий пароль не подошёл',
  [ChangePasswordApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен. Войди заново',
}

const FALLBACK = 'Не получилось сменить пароль. Попробуй ещё раз'

export default function ChangePasswordPage({ f7router }: { f7router: Router.Router }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    const invalid = (message: string) => {
      reportForm('change_password', 'invalid')
      setError(message)
    }
    if (!currentPassword || !newPassword || !confirmPassword) return invalid('Заполни все поля')
    const problem = passwordProblem(newPassword)
    if (problem) return invalid(problem)
    if (newPassword !== confirmPassword) return invalid('Пароли не совпадают')
    if (newPassword === currentPassword) return invalid('Новый пароль должен отличаться от текущего')

    setError('')
    setLoading(true)
    try {
      const result = await changePassword(currentPassword, newPassword)
      if (!result.ok) {
        reportForm('change_password', outcomeFromCode(result.code))
        setError(codeText(CHANGE_PASSWORD_ERRORS, result.code, FALLBACK))
        return
      }
      reportForm('change_password', 'success')
      f7.toast.create({ text: 'Пароль изменён', closeTimeout: 2000 }).open()
      f7router.back()
    } catch (err) {
      reportForm('change_password', outcomeFromError(err))
      setError(apiErrorText(err, { byStatus: { 422: `Пароль — от ${InputLimit.PasswordMin} символов` } }, FALLBACK))
    } finally {
      setLoading(false)
    }
  }

  const clear = () => setError('')

  return (
    <Page name="change-password">
      <Navbar backLink="Профиль" title="Изменить пароль" />
      <List form className="rd-form">
        <PasswordInput
          label="Текущий пароль"
          name="current-password"
          value={currentPassword}
          autocomplete="current-password"
          onChange={(value) => {
            setCurrentPassword(value)
            clear()
          }}
        />
        <PasswordInput
          label="Новый пароль"
          name="new-password"
          value={newPassword}
          autocomplete="new-password"
          info={`Не меньше ${InputLimit.PasswordMin} символов`}
          onChange={(value) => {
            setNewPassword(value)
            clear()
          }}
        />
        <PasswordInput
          label="Повтори новый пароль"
          name="repeat-password"
          value={confirmPassword}
          autocomplete="new-password"
          onChange={(value) => {
            setConfirmPassword(value)
            clear()
          }}
        />
      </List>
      <Block className="rd-form-actions">
        {error && <p className="rd-form-error" data-testid="form-error">{error}</p>}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleSave()}>
          Изменить пароль
        </Button>
      </Block>
    </Page>
  )
}
