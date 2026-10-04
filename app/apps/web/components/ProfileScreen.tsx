'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { LogOut } from 'lucide-react'
import { apiErrorText } from '@ryadom/client-core/errors'
import { nameProblem } from '@ryadom/client-core/validation'
import { Avatar, AvatarFallback } from '@ryadom/ui/components/avatar'
import { Card, CardContent } from '@ryadom/ui/components/card'
import { Field, FieldError } from '@ryadom/ui/components/field'
import { Input } from '@ryadom/ui/components/input'
import { Label } from '@ryadom/ui/components/label'
import { Separator } from '@ryadom/ui/components/separator'
import { useAuth, useClient } from '@/lib/auth'
import Modal from './Modal'
import LinkEmailForm from './ProfileLinkEmail'
import { useNotice } from './Notice'
import {
  Busy,
  FIELD_FOCUS,
  ModalActions,
  ModalText,
  ProfileButton,
  SettingsSection,
} from './ProfileParts'
import { Page } from './Page'
import ProfileRow from './ProfileRow'

/**
 * Profile as a classic settings page: one column of sections (the account, security, support,
 * documents, the app), sign-out, and the danger zone at the bottom.
 *
 * Deletion is visible here rather than hidden away in support: the stores require it (App Store
 * 5.1.1(v), Google Play) and the spec promises erasing everything with one button.
 */
export default function ProfileScreen({ webUrl }: { webUrl: string }) {
  const client = useClient()
  const router = useRouter()
  const { user, logout, updateUser } = useAuth()
  const [nameOpen, setNameOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const userId = user?.id ?? null

  // Sign-in returns only the basic fields; the rest of the profile comes from the server.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    client
      .getCurrentUser()
      .then((me) => {
        if (cancelled) return
        updateUser({
          email: me.email,
          name: me.name,
          isEmailConfirmed: me.isEmailConfirmed,
          createdAt: me.createdAt,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, userId, updateUser])

  async function handleLogout() {
    setLoggingOut(true)
    try {
      await logout()
      router.replace('/login')
    } finally {
      setLoggingOut(false)
    }
  }

  const name = user?.name?.trim() || null
  const initial = (name ?? user?.email ?? '').charAt(0).toUpperCase()
  // An anonymous account has no address and no password; one that linked an address and has not yet
  // entered the code is waiting for the second step.
  const noEmail = user?.email === null
  const pendingEmail = user?.email && user.isEmailConfirmed === false ? user.email : null

  return (
    <Page title="Профиль" className="tab:gap-5">
      <Card className="@container rounded-lg tab:[--card-spacing:--spacing(5)]">
        {/* Under the name on a narrow card, at its natural width; beside it once the card is wide enough. */}
        <CardContent className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4 @lg:grid-cols-[auto_minmax(0,1fr)_auto]">
          <Avatar aria-hidden="true" className="size-14 after:border-0 tab:size-16">
            <AvatarFallback className="border border-brand-line bg-brand-soft text-xl leading-none font-bold text-brand-400">
              {initial || '·'}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p
              className="text-xl leading-tight font-semibold tracking-display wrap-break-word"
              data-testid="profile-name"
            >
              {name ?? '—'}
            </p>
            <p className="mt-0.5 text-[0.9375rem] text-dim wrap-break-word" data-testid="profile-email">
              {noEmail ? 'Без регистрации' : (user?.email ?? '')}
            </p>
          </div>
          <ProfileButton
            type="button"
            variant="outline"
            size="sm"
            className="col-span-full justify-self-start px-4 @lg:col-auto @lg:justify-self-end"
            data-testid="edit-name"
            onClick={() => setNameOpen(true)}
          >
            Изменить имя
          </ProfileButton>
        </CardContent>
      </Card>

      <SettingsSection title="Безопасность">
        {noEmail ? (
          <li>
            <ProfileRow
              icon="mail"
              label="Привязать почту"
              value="чтобы войти с другого устройства"
              testId="row-link-email"
              onClick={() => setLinkOpen(true)}
            />
          </li>
        ) : (
          <>
            {pendingEmail && (
              <li>
                <ProfileRow
                  icon="mail"
                  label="Подтвердить почту"
                  value={pendingEmail}
                  testId="row-confirm-email"
                  onClick={() => setLinkOpen(true)}
                />
              </li>
            )}
            <li>
              <ProfileRow
                icon="lock"
                label="Изменить пароль"
                href="/profile/change-password"
                testId="row-change-password"
              />
            </li>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Поддержка">
        <li>
          <ProfileRow icon="users" label="Люди рядом" href="/people" testId="row-people" />
        </li>
      </SettingsSection>

      <SettingsSection title="Документы">
        <li>
          <ProfileRow
            icon="doc"
            label="Условия использования"
            href={`${webUrl}/terms`}
            external
            testId="row-terms"
          />
        </li>
        <li>
          <ProfileRow
            icon="doc"
            label="Политика обработки персональных данных"
            href={`${webUrl}/privacy`}
            external
            testId="row-privacy"
          />
        </li>
      </SettingsSection>

      <SettingsSection title="Приложение">
        <li>
          <ProfileRow
            icon="info"
            label="О приложении"
            value="Веб-версия"
            testId="row-about"
            onClick={() => setAboutOpen(true)}
          />
        </li>
      </SettingsSection>

      <ProfileButton
        type="button"
        variant="outline"
        className="w-full tab:w-auto tab:self-start tab:px-6"
        data-testid="logout"
        onClick={() => setLogoutOpen(true)}
      >
        <LogOut aria-hidden="true" />
        Выйти из аккаунта
      </ProfileButton>

      {/* Set apart from everything above, so it is never hit while reaching for something else. */}
      <Separator />

      <SettingsSection
        title="Опасная зона"
        danger
        note="Удаление необратимо: разговоры, память и профиль стираются, аккаунт тоже. Восстановить нельзя."
      >
        <li>
          <ProfileRow
            icon="trash"
            label="Стереть всё и удалить аккаунт"
            href="/profile/delete"
            danger
            testId="row-delete-account"
          />
        </li>
      </SettingsSection>

      <Modal open={nameOpen} onClose={() => setNameOpen(false)} title="Имя">
        <NameForm
          initial={user?.name ?? ''}
          onDone={() => setNameOpen(false)}
          onCancel={() => setNameOpen(false)}
        />
      </Modal>

      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Почта для входа">
        <LinkEmailForm
          pendingEmail={pendingEmail}
          onDone={() => setLinkOpen(false)}
          onCancel={() => setLinkOpen(false)}
        />
      </Modal>

      <Modal open={aboutOpen} onClose={() => setAboutOpen(false)} title="О приложении">
        <ModalText>«Рядом»&nbsp;— сервис самоподдержки, не медицинская услуга и не психотерапия.</ModalText>
        <ModalText>Веб-версия</ModalText>
        <ProfileButton type="button" className="w-full" onClick={() => setAboutOpen(false)}>
          ОК
        </ProfileButton>
      </Modal>

      <Modal open={logoutOpen} onClose={() => setLogoutOpen(false)} title="Выход" dismissible={!loggingOut}>
        <ModalText>Выйти из аккаунта на этом устройстве?</ModalText>
        <ModalActions>
          <ProfileButton
            type="button"
            variant="outline"
            disabled={loggingOut}
            onClick={() => setLogoutOpen(false)}
          >
            Отмена
          </ProfileButton>
          <ProfileButton
            type="button"
            data-testid="logout-confirm"
            aria-busy={loggingOut || undefined}
            onClick={() => void handleLogout()}
          >
            <Busy on={loggingOut} />
            ОК
          </ProfileButton>
        </ModalActions>
      </Modal>
    </Page>
  )
}

/** Its own component so the field starts from the current name each time the modal opens. */
function NameForm({ initial, onDone, onCancel }: { initial: string; onDone(): void; onCancel(): void }) {
  const client = useClient()
  const { updateUser } = useAuth()
  const notify = useNotice()
  const [value, setValue] = useState(initial)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const fieldId = useId()
  const errorId = `${fieldId}-error`

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const problem = nameProblem(value)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setSaving(true)
    try {
      const me = await client.updateProfile({ name: value.trim() })
      updateUser({ name: me.name })
      notify('Имя сохранено', 'success')
      onDone()
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось сохранить имя'))
      setSaving(false)
    }
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <Field role={undefined}>
        <Label htmlFor={fieldId} className="leading-normal">
          Как к тебе обращаться?
        </Label>
        <Input
          id={fieldId}
          name="name"
          type="text"
          className={FIELD_FOCUS}
          value={value}
          autoComplete="given-name"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setValue(event.target.value)
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
        <ProfileButton type="button" variant="outline" onClick={onCancel}>
          Отмена
        </ProfileButton>
        <ProfileButton type="submit" data-testid="name-save" aria-busy={saving || undefined}>
          <Busy on={saving} />
          ОК
        </ProfileButton>
      </ModalActions>
    </form>
  )
}
