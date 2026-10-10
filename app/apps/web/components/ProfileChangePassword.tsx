'use client'

import { useRouter } from 'next/navigation'
import { useId, useRef, useState, type ComponentProps, type FormEvent } from 'react'
import type { FormOutcome } from '@ryadom/analytics/events'
import { ChangePasswordApiErrorCode } from '@ryadom/contracts/api/auth/password'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { passwordProblem } from '@ryadom/client-core/validation'
import { Card, CardContent } from '@ryadom/ui/components/card'
import { Field, FieldDescription, FieldError, FieldGroup } from '@ryadom/ui/components/field'
import { Label } from '@ryadom/ui/components/label'
import { PasswordInput } from '@ryadom/ui/components/password-input'
import { formOutcome, trackForm } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { useNotice } from './Notice'
import { Page } from './Page'
import { Busy, FIELD_FOCUS, ProfileButton } from './ProfileParts'

/** Password change that requires the current password. The session stays signed in. */

const CHANGE_PASSWORD_ERRORS: Record<ChangePasswordApiErrorCode, string> = {
  [ChangePasswordApiErrorCode.INVALID_CURRENT_PASSWORD]: 'Текущий пароль не подошёл',
  [ChangePasswordApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен. Войди заново',
}

const FALLBACK = 'Не получилось сменить пароль. Попробуй ещё раз'

type FieldName = 'currentPassword' | 'newPassword' | 'repeatPassword'

export default function ProfileChangePassword() {
  const client = useClient()
  const router = useRouter()
  const notify = useNotice()
  const { user } = useAuth()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeatPassword, setRepeatPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Which field the message is about: it gets the red border, aria-invalid and the focus.
  const [invalidField, setInvalidField] = useState<FieldName | null>(null)
  const errorId = useId()

  const inputRefs = {
    currentPassword: useRef<HTMLInputElement>(null),
    newPassword: useRef<HTMLInputElement>(null),
    repeatPassword: useRef<HTMLInputElement>(null),
  }

  function fail(message: string, field: FieldName | null, outcome: FormOutcome = 'invalid') {
    trackForm('change_password', outcome)
    setError(message)
    setInvalidField(field)
    if (field) inputRefs[field].current?.focus()
  }

  function clear() {
    setError('')
    setInvalidField(null)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (loading) return

    if (!currentPassword) return fail('Заполни все поля', 'currentPassword')
    if (!newPassword) return fail('Заполни все поля', 'newPassword')
    if (!repeatPassword) return fail('Заполни все поля', 'repeatPassword')
    const problem = passwordProblem(newPassword)
    if (problem) return fail(problem, 'newPassword')
    if (newPassword !== repeatPassword) return fail('Пароли не совпадают', 'repeatPassword')
    if (newPassword === currentPassword)
      return fail('Новый пароль должен отличаться от текущего', 'newPassword')

    clear()
    setLoading(true)
    try {
      const result = await client.changePassword(currentPassword, newPassword)
      if (!result.ok) {
        fail(
          codeText(CHANGE_PASSWORD_ERRORS, result.code, FALLBACK),
          result.code === ChangePasswordApiErrorCode.INVALID_CURRENT_PASSWORD ? 'currentPassword' : null,
          'rejected',
        )
        return
      }
      trackForm('change_password', 'success')
      notify('Пароль изменён', 'success')
      router.replace('/profile')
    } catch (err) {
      fail(
        apiErrorText(err, { byStatus: { 422: `Пароль — от ${InputLimit.PasswordMin} символов` } }, FALLBACK),
        null,
        formOutcome(err),
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page title="Изменить пароль" back={{ href: '/profile', label: 'Профиль' }} measure="form">
      <Card className="rounded-lg tab:[--card-spacing:--spacing(6)]">
        <CardContent>
          <form className="flex flex-col gap-6" noValidate onSubmit={(event) => void handleSubmit(event)}>
            {/* Gives the password manager the account it should update; invisible and out of the tab order. */}
            <input
              className="sr-only"
              type="text"
              name="username"
              autoComplete="username"
              value={user?.email ?? ''}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
            <FieldGroup className="gap-4">
              <PasswordField
                ref={inputRefs.currentPassword}
                label="Текущий пароль"
                name="current-password"
                autoComplete="current-password"
                value={currentPassword}
                invalid={invalidField === 'currentPassword'}
                errorId={errorId}
                onValueChange={(value) => {
                  setCurrentPassword(value)
                  clear()
                }}
              />
              <PasswordField
                ref={inputRefs.newPassword}
                label="Новый пароль"
                name="new-password"
                autoComplete="new-password"
                hint={`Не меньше ${InputLimit.PasswordMin} символов`}
                value={newPassword}
                invalid={invalidField === 'newPassword'}
                errorId={errorId}
                onValueChange={(value) => {
                  setNewPassword(value)
                  clear()
                }}
              />
              <PasswordField
                ref={inputRefs.repeatPassword}
                label="Повтори новый пароль"
                name="repeat-password"
                autoComplete="new-password"
                value={repeatPassword}
                invalid={invalidField === 'repeatPassword'}
                errorId={errorId}
                onValueChange={(value) => {
                  setRepeatPassword(value)
                  clear()
                }}
              />
            </FieldGroup>
            <div className="flex flex-col gap-4">
              {error && (
                <FieldError id={errorId} className="text-center leading-[1.4]" data-testid="form-error">
                  {error}
                </FieldError>
              )}
              <ProfileButton
                type="submit"
                className="w-full"
                data-testid="change-password-submit"
                aria-busy={loading || undefined}
              >
                <Busy on={loading} />
                Изменить пароль
              </ProfileButton>
            </div>
          </form>
        </CardContent>
      </Card>
    </Page>
  )
}

interface PasswordFieldProps extends Pick<ComponentProps<typeof PasswordInput>, 'ref' | 'name' | 'value'> {
  label: string
  autoComplete: 'current-password' | 'new-password'
  hint?: string
  /** Id of an element that explains the current error; wired to aria-describedby. */
  errorId?: string
  invalid?: boolean
  onValueChange(value: string): void
}

function PasswordField({
  label,
  name,
  value,
  onValueChange,
  autoComplete,
  hint,
  errorId,
  invalid = false,
  ref,
}: PasswordFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const describedBy = [hint ? hintId : null, invalid ? errorId : null].filter(Boolean).join(' ') || undefined

  return (
    // The reveal button belongs to the shared PasswordInput, whose focus ring is a shadow and is dropped
    // in forced-colors mode: give the button the transparent outline that mode paints.
    <Field role={undefined} className="[&_[data-slot=button]]:focus-visible:outline-hidden">
      <Label htmlFor={id} className="leading-normal">
        {label}
      </Label>
      <PasswordInput
        ref={ref}
        id={id}
        // Password managers key off the name and autocomplete to decide what to offer.
        name={name}
        value={value}
        autoComplete={autoComplete}
        className={FIELD_FOCUS}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {hint && (
        <FieldDescription id={hintId} className="text-[0.8125rem] text-faint">
          {hint}
        </FieldDescription>
      )}
    </Field>
  )
}
