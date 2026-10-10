import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Block, Button, Icon, List, ListInput, Navbar, Page, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useEffect, useState, type ChangeEvent } from 'react'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { LinkEmailApiErrorCode } from '@ryadom/contracts/api/auth/link-email'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import {
  apiErrorText,
  codeText,
  confirmEmail,
  forgetDevice,
  linkEmail,
  resendConfirmation,
} from '../../../lib/api'
import { useAuth } from '../../../lib/store'
import { passwordProblem } from '../../../lib/validation'
import CodeInput from '../../CodeInput'
import PasswordInput from '../../PasswordInput'

/**
 * Gives an anonymous account an address and a password, then confirms the address with the code
 * from the email: two steps on one screen, so the person stays in the profile. A person who linked
 * an address and left before entering the code comes back straight to the second step
 * (`pendingEmail`).
 */

const LINK_ERRORS: Record<LinkEmailApiErrorCode, string> = {
  [LinkEmailApiErrorCode.EMAIL_TAKEN]:
    'Эта почта уже занята другим аккаунтом. Укажи другую или войди в тот аккаунт: разговоры этого телефона в него не перенесутся',
  [LinkEmailApiErrorCode.ALREADY_HAS_EMAIL]: 'К аккаунту уже привязана почта',
  [LinkEmailApiErrorCode.DISPOSABLE_EMAIL]:
    'Одноразовые адреса не подходят: на них не прочитать код. Укажи свою почту',
  [LinkEmailApiErrorCode.USER_NOT_FOUND]: 'Аккаунт не найден',
  [LinkEmailApiErrorCode.USER_INACTIVE]: 'Аккаунт заблокирован',
}

const CONFIRM_ERRORS: Record<ConfirmEmailApiErrorCode, string> = {
  [ConfirmEmailApiErrorCode.CODE_INVALID]: 'Код не подошёл. Проверь письмо или запроси новый',
  [ConfirmEmailApiErrorCode.TOO_MANY_ATTEMPTS]: 'Слишком много попыток. Запроси новый код',
  [ConfirmEmailApiErrorCode.EMAIL_ALREADY_CONFIRMED]: 'Почта уже подтверждена',
}

const RESEND_COOLDOWN_SEC = 60

export default function LinkEmailPage({
  f7router,
  pendingEmail,
}: {
  f7router: Router.Router
  pendingEmail?: string
}) {
  const { updateUser, leaveAnonymousAccount } = useAuth()
  const [taken, setTaken] = useState(false)
  const [step, setStep] = useState<'address' | 'code'>(pendingEmail ? 'code' : 'address')
  const [email, setEmail] = useState(pendingEmail ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(pendingEmail ? 0 : RESEND_COOLDOWN_SEC)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  async function handleLink() {
    const invalid = (message: string) => {
      reportForm('link_email', 'invalid')
      setError(message)
    }
    const address = email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(address)) return invalid('Проверь адрес почты')
    const weak = passwordProblem(password)
    if (weak) return invalid(weak)

    setError('')
    setTaken(false)
    setLoading(true)
    try {
      const outcome = await linkEmail(address, password)
      if (!outcome.ok) {
        reportForm('link_email', outcomeFromCode(outcome.code))
        setError(codeText(LINK_ERRORS, outcome.code, 'Не получилось привязать почту'))
        setTaken(outcome.code === LinkEmailApiErrorCode.EMAIL_TAKEN)
        return
      }
      reportForm('link_email', 'success')
      setEmail(outcome.data.email)
      updateUser({ email: outcome.data.email, isEmailConfirmed: false })
      setCooldown(RESEND_COOLDOWN_SEC)
      setStep('code')
    } catch (err) {
      reportForm('link_email', outcomeFromError(err))
      setError(
        apiErrorText(
          err,
          { byStatus: { 422: 'Проверь адрес почты и длину пароля' } },
          'Не получилось привязать почту',
        ),
      )
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm(value = code) {
    if (value.length !== 6) {
      reportForm('confirm_email', 'invalid')
      return setError('Код — шесть цифр из письма')
    }
    setError('')
    setLoading(true)
    let confirmed = false
    try {
      const outcome = await confirmEmail(email, value)
      if (!outcome.ok) {
        reportForm('confirm_email', outcomeFromCode(outcome.code))
        setError(codeText(CONFIRM_ERRORS, outcome.code, 'Не получилось подтвердить почту'))
        return
      }
      confirmed = true
      reportForm('confirm_email', 'success')
      updateUser({ isEmailConfirmed: true })
      // The account has a password now, and the server forgets the phone's key with the confirmation.
      await forgetDevice()
      f7.toast
        .create({
          text: 'Почта подтверждена: в аккаунт можно войти с другого устройства',
          closeTimeout: 3000,
        })
        .open()
      f7router.back()
    } catch (err) {
      // After the code was accepted a failure belongs to what follows, not to this form.
      if (!confirmed) reportForm('confirm_email', outcomeFromError(err))
      setError(apiErrorText(err, {}, 'Не получилось подтвердить почту'))
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setCooldown(RESEND_COOLDOWN_SEC)
    setCode('')
    setError('')
    try {
      await resendConfirmation(email)
      track(AnalyticsEvent.EmailCodeResent, { form: 'confirm_email' })
      f7.toast.create({ text: 'Отправили новый код', closeTimeout: 2500 }).open()
    } catch {
      f7.toast.create({ text: 'Не получилось отправить письмо', closeTimeout: 2500 }).open()
    }
  }

  function handleSwitchAccount() {
    f7.dialog.confirm(
      `Разговоры этого телефона в тот аккаунт не перенесутся. Вернуться в этот профиль будет нельзя, и через ${ANONYMOUS_RETENTION_DAYS} дней он удалится вместе с разговорами.`,
      'Войти в тот аккаунт',
      () => void leaveAnonymousAccount(),
    )
  }

  if (step === 'code') {
    return (
      <Page name="link-email-code" className="rd-page-auth">
        <Navbar backLink="Профиль" transparent />
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
            <span className="rd-nowrap">Введи его&nbsp;— и почта будет подтверждена.</span>
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
          {error && (
            <p className="rd-form-error" data-testid="form-error">
              {error}
            </p>
          )}
          <Button
            fill
            large
            preloader
            loading={loading}
            disabled={loading}
            onClick={() => void handleConfirm()}
          >
            Подтвердить
          </Button>
          <Button large outline disabled={cooldown > 0} onClick={() => void handleResend()}>
            {cooldown > 0 ? `Отправить снова через ${cooldown} с` : 'Отправить код снова'}
          </Button>
        </Block>
      </Page>
    )
  }

  return (
    <Page name="link-email" className="rd-page-auth">
      <Navbar backLink="Профиль" title="Почта для входа" transparent />
      <div className="rd-done">
        <p className="rd-muted">
          Без почты аккаунт живёт только на этом устройстве и удаляется через {ANONYMOUS_RETENTION_DAYS} дней
          без визитов. С почтой и паролем разговоры не потеряются, и в аккаунт можно войти с другого
          устройства.
        </p>
      </div>

      <List
        form
        className="rd-form"
        onSubmit={(event) => {
          event.preventDefault()
          void handleLink()
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
        <PasswordInput
          label="Пароль для входа по почте"
          name="password"
          value={password}
          autocomplete="new-password"
          onChange={(value) => {
            setPassword(value)
            setError('')
            setTaken(false)
          }}
        />
        <button type="submit" className="rd-submit-hidden" tabIndex={-1} aria-hidden="true" />
      </List>

      <Block className="rd-form-actions">
        {error && (
          <p className="rd-form-error" data-testid="form-error">
            {error}
          </p>
        )}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleLink()}>
          Отправить код
        </Button>
        {taken && (
          <Button large outline onClick={handleSwitchAccount} data-testid="link-email-switch">
            Войти в тот аккаунт
          </Button>
        )}
      </Block>
    </Page>
  )
}
