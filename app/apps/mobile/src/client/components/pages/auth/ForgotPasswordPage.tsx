import { Block, Button, List, ListInput, Navbar, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState, type ChangeEvent } from 'react'
import { outcomeFromError, reportForm } from '../../../lib/analytics'
import { apiErrorText, requestPasswordReset } from '../../../lib/api'

/**
 * First step of a password change: the email. The response is identical for an existing and a
 * missing address, so the screen goes straight to code entry and promises nothing.
 */
export default function ForgotPasswordPage({ f7router }: { f7router: Router.Router }) {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) {
      reportForm('forgot_password', 'invalid')
      return setError('Напиши почту')
    }
    setError('')
    setLoading(true)
    try {
      await requestPasswordReset(trimmed)
      reportForm('forgot_password', 'success')
      f7router.navigate('/reset-password/', { props: { email: trimmed } })
    } catch (err) {
      reportForm('forgot_password', outcomeFromError(err))
      setError(apiErrorText(err, {}, 'Не получилось отправить код. Попробуй ещё раз'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page name="forgot-password" className="rd-page-auth ph-no-capture">
      <Navbar backLink="Назад" transparent />
      <div className="rd-auth-head">
        <h1 className="rd-title">Восстановим доступ</h1>
        <p className="rd-muted">Напиши почту, на которую заведён аккаунт,&nbsp;— пришлём код для смены пароля.</p>
      </div>
      <List
        form
        className="rd-form"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSubmit()
        }}
      >
        <ListInput
          label="Почта"
          name="email"
          type="email"
          value={email}
          outline
          floatingLabel
          clearButton
          autocomplete="email"
          inputmode="email"
          autocapitalize="off"
          onInput={(event: ChangeEvent<HTMLInputElement>) => {
            setEmail(event.target.value)
            setError('')
          }}
        />
        <button type="submit" className="rd-submit-hidden" tabIndex={-1} aria-hidden="true" />
      </List>
      <Block className="rd-form-actions">
        {error && <p className="rd-form-error" data-testid="form-error">{error}</p>}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleSubmit()}>
          Прислать код
        </Button>
      </Block>
    </Page>
  )
}
