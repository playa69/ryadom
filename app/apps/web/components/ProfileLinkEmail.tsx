'use client'

import { useId, useState, type FormEvent } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type FormOutcome } from '@ryadom/analytics/events'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { LinkEmailApiErrorCode } from '@ryadom/contracts/api/auth/link-email'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { codeProblem, passwordProblem } from '@ryadom/client-core/validation'
import { Field, FieldError } from '@ryadom/ui/components/field'
import { Input } from '@ryadom/ui/components/input'
import { Label } from '@ryadom/ui/components/label'
import { codeOutcome, formOutcome, trackForm } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { useNotice } from './Notice'
import { Busy, FIELD_FOCUS, ModalActions, ModalText, ProfileButton } from './ProfileParts'

/**
 * Gives an anonymous account an address and a password, then confirms the address with the code
 * from the email. Two steps in one dialog, so the person stays on the profile. A person who linked
 * an address and left before entering the code comes back straight to the second step.
 */

const LINK_ERRORS: Record<LinkEmailApiErrorCode, string> = {
  [LinkEmailApiErrorCode.EMAIL_TAKEN]:
    'Эта почта уже занята другим аккаунтом. Укажи другую или войди в тот аккаунт: разговоры этого устройства в него не перенесутся',
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

export default function LinkEmailForm({
  pendingEmail,
  onDone,
  onCancel,
  onSwitchAccount,
}: {
  /** An address that was linked but not yet confirmed: the form opens at the code step. */
  pendingEmail: string | null
  onDone(): void
  onCancel(): void
  /** The address belongs to an account the person already has: the way to sign in to it instead. */
  onSwitchAccount(): void
}) {
  const client = useClient()
  const { updateUser } = useAuth()
  const notify = useNotice()
  const [step, setStep] = useState<'address' | 'code'>(pendingEmail ? 'code' : 'address')
  const [email, setEmail] = useState(pendingEmail ?? '')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [taken, setTaken] = useState(false)
  const [busy, setBusy] = useState(false)
  const fieldId = useId()
  const errorId = `${fieldId}-error`

  /** A message the person sees; reported as the outcome of the form it belongs to. */
  function refuse(form: 'link_email' | 'confirm_email', message: string, outcome: FormOutcome = 'invalid') {
    trackForm(form, outcome)
    setError(message)
  }

  async function linkAddress(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const address = email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(address)) return refuse('link_email', 'Проверь адрес почты')
    const weak = passwordProblem(password)
    if (weak) return refuse('link_email', weak)

    setError('')
    setTaken(false)
    setBusy(true)
    try {
      const outcome = await client.linkEmail(address, password)
      if (!outcome.ok) {
        refuse(
          'link_email',
          codeText(LINK_ERRORS, outcome.code, 'Не получилось привязать почту'),
          codeOutcome(outcome.code),
        )
        setTaken(outcome.code === LinkEmailApiErrorCode.EMAIL_TAKEN)
        return
      }
      trackForm('link_email', 'success')
      setEmail(outcome.data.email)
      updateUser({ email: outcome.data.email, isEmailConfirmed: false })
      setStep('code')
    } catch (err) {
      trackForm('link_email', formOutcome(err))
      setError(
        apiErrorText(
          err,
          { byStatus: { 422: 'Проверь адрес почты и длину пароля' } },
          'Не получилось привязать почту',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  async function confirmAddress(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const invalid = codeProblem(code)
    if (invalid) return refuse('confirm_email', invalid)

    setError('')
    setBusy(true)
    try {
      const outcome = await client.confirmEmail(email, code)
      if (!outcome.ok) {
        refuse(
          'confirm_email',
          codeText(CONFIRM_ERRORS, outcome.code, 'Не получилось подтвердить почту'),
          codeOutcome(outcome.code),
        )
        return
      }
      trackForm('confirm_email', 'success')
      updateUser({ isEmailConfirmed: true })
      // The account has a password now, and the server forgets the device's key with the confirmation.
      await client.forgetDevice()
      notify('Почта подтверждена: теперь в аккаунт можно войти с другого устройства', 'success')
      onDone()
    } catch (err) {
      trackForm('confirm_email', formOutcome(err))
      setError(apiErrorText(err, {}, 'Не получилось подтвердить почту'))
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    if (busy) return
    setCode('')
    setError('')
    try {
      await client.resendConfirmation(email)
      track(AnalyticsEvent.EmailCodeResent, { form: 'confirm_email' })
      notify('Отправили новый код', 'success')
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось отправить письмо'), 'error')
    }
  }

  if (step === 'code') {
    return (
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void confirmAddress(event)}>
        <ModalText>
          Мы отправили код на <b className="wrap-anywhere">{email}</b>. Введи его, чтобы почта считалась
          подтверждённой.
        </ModalText>
        <Field role={undefined}>
          <Label htmlFor={fieldId} className="leading-normal">
            Код из письма
          </Label>
          <Input
            id={fieldId}
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className={FIELD_FOCUS}
            value={code}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            data-testid="link-email-code"
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, ''))
              setError('')
            }}
          />
        </Field>
        {error && (
          <FieldError id={errorId} className="text-center leading-[1.4]" data-testid="form-error">
            {error}
          </FieldError>
        )}
        <ModalActions>
          <ProfileButton type="button" variant="outline" onClick={() => void resend()}>
            Отправить ещё раз
          </ProfileButton>
          <ProfileButton type="submit" data-testid="link-email-confirm" aria-busy={busy || undefined}>
            <Busy on={busy} />
            Подтвердить
          </ProfileButton>
        </ModalActions>
      </form>
    )
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void linkAddress(event)}>
      <ModalText>
        Без почты аккаунт живёт только на этом устройстве и удаляется через {ANONYMOUS_RETENTION_DAYS} дней
        без визитов. С почтой и паролем разговоры не потеряются, и в аккаунт можно войти с другого устройства.
      </ModalText>
      <Field role={undefined}>
        <Label htmlFor={`${fieldId}-email`} className="leading-normal">
          Почта
        </Label>
        <Input
          id={`${fieldId}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={FIELD_FOCUS}
          value={email}
          autoFocus
          data-testid="link-email-address"
          onChange={(event) => {
            setEmail(event.target.value)
            setError('')
          }}
        />
      </Field>
      <Field role={undefined}>
        <Label htmlFor={`${fieldId}-password`} className="leading-normal">
          Пароль для входа по почте
        </Label>
        <Input
          id={`${fieldId}-password`}
          name="password"
          type="password"
          autoComplete="new-password"
          className={FIELD_FOCUS}
          value={password}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          data-testid="link-email-password"
          onChange={(event) => {
            setPassword(event.target.value)
            setError('')
            setTaken(false)
          }}
        />
      </Field>
      {error && (
        <FieldError id={errorId} className="text-center leading-[1.4]" data-testid="form-error">
          {error}
        </FieldError>
      )}
      {taken && (
        <ProfileButton
          type="button"
          variant="outline"
          data-testid="link-email-switch"
          onClick={onSwitchAccount}
        >
          Войти в тот аккаунт
        </ProfileButton>
      )}
      <ModalActions>
        <ProfileButton type="button" variant="outline" onClick={onCancel}>
          Отмена
        </ProfileButton>
        <ProfileButton type="submit" data-testid="link-email-submit" aria-busy={busy || undefined}>
          <Busy on={busy} />
          Отправить код
        </ProfileButton>
      </ModalActions>
    </form>
  )
}
