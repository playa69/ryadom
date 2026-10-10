import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Block, Button, Icon, Navbar, Page, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useEffect, useState } from 'react'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import { apiErrorText, codeText, confirmEmail, login, resendConfirmation } from '../../../lib/api'
import { useAuth } from '../../../lib/store'
import CodeInput from '../../CodeInput'

/**
 * Email confirmation code entry. When the password came from the registration
 * screen, we sign the person in right after confirmation: they typed it a moment ago, so there is
 * no reason to ask a second time.
 */

const CONFIRM_ERRORS: Record<ConfirmEmailApiErrorCode, string> = {
  [ConfirmEmailApiErrorCode.CODE_INVALID]: 'Код не подошёл. Проверь письмо или запроси новый',
  [ConfirmEmailApiErrorCode.TOO_MANY_ATTEMPTS]: 'Слишком много попыток. Запроси новый код',
  [ConfirmEmailApiErrorCode.EMAIL_ALREADY_CONFIRMED]: 'Почта уже подтверждена — можно входить',
}

const RESEND_COOLDOWN_SEC = 60

export default function ConfirmEmailPage({
  f7router,
  email,
  password,
  consented,
}: {
  f7router: Router.Router
  email: string
  password?: string
  /** The person agreed to the terms on the registration screen: it is recorded once the session starts. */
  consented?: boolean
}) {
  const { login: storeLogin } = useAuth()
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SEC)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  async function handleConfirm(value = code) {
    if (value.length !== 6) {
      reportForm('confirm_email', 'invalid')
      return setError('Код — шесть цифр из письма')
    }
    setError('')
    setLoading(true)
    let confirmed = false
    try {
      const result = await confirmEmail(email, value)
      if (!result.ok) {
        reportForm('confirm_email', outcomeFromCode(result.code))
        setError(codeText(CONFIRM_ERRORS, result.code, 'Не получилось подтвердить почту'))
        return
      }
      confirmed = true
      reportForm('confirm_email', 'success')
      if (password) {
        const { user, tokens } = await login(email, password)
        await storeLogin(user, tokens, { consent: consented })
        return
      }
      f7.toast.create({ text: 'Почта подтверждена — можно входить', closeTimeout: 2500 }).open()
      f7router.navigate('/login/', { clearPreviousHistory: true })
    } catch (err) {
      // After the code was accepted a failure belongs to the sign-in that follows, not to this form.
      if (!confirmed) reportForm('confirm_email', outcomeFromError(err))
      setError(apiErrorText(err, {}, 'Не получилось подтвердить почту'))
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setCooldown(RESEND_COOLDOWN_SEC)
    try {
      await resendConfirmation(email)
      track(AnalyticsEvent.EmailCodeResent, { form: 'confirm_email' })
      f7.toast.create({ text: 'Отправили новый код', closeTimeout: 2500 }).open()
    } catch {
      f7.toast.create({ text: 'Не получилось отправить письмо', closeTimeout: 2500 }).open()
    }
  }

  return (
    <Page name="confirm-email" className="rd-page-auth ph-no-capture">
      <Navbar backLink="Назад" transparent />
      <div className="rd-done">
        <span className="rd-done-icon">
          <Icon f7="envelope_fill" size={30} />
        </span>
        <h1 className="rd-title">Подтверди почту</h1>
        <p className="rd-muted">
          Мы отправили код на{' '}
          <span className="rd-email-end">
            <b className="rd-email">{email}</b>.
          </span>{' '}
          <span className="rd-nowrap">Введи его&nbsp;— и можно начинать.</span>
        </p>
      </div>

      <CodeInput
        value={code}
        disabled={loading}
        onChange={(value) => {
          setCode(value)
          setError('')
        }}
        onComplete={(value) => void handleConfirm(value)}
      />

      <Block className="rd-form-actions">
        {error && <p className="rd-form-error" data-testid="form-error">{error}</p>}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleConfirm()}>
          Подтвердить
        </Button>
        <Button large outline disabled={cooldown > 0} onClick={() => void handleResend()}>
          {cooldown > 0 ? `Отправить снова через ${cooldown} с` : 'Отправить код снова'}
        </Button>
        <p className="rd-fineprint">Письма нет? Загляни в «Спам»&nbsp;— иногда оно попадает туда.</p>
      </Block>
    </Page>
  )
}
