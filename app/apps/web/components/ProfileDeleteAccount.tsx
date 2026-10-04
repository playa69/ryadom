'use client'

import { useRouter } from 'next/navigation'
import { useId, useState, type ComponentProps, type ReactNode } from 'react'
import { Mail, MessageSquareText, TriangleAlert, UserX, type LucideIcon } from 'lucide-react'
import { apiErrorText } from '@ryadom/client-core/errors'
import { Alert, AlertDescription, AlertTitle } from '@ryadom/ui/components/alert'
import { Card, CardContent } from '@ryadom/ui/components/card'
import { Checkbox } from '@ryadom/ui/components/checkbox'
import { Field, FieldLabel } from '@ryadom/ui/components/field'
import { Item, ItemContent } from '@ryadom/ui/components/item'
import { cn } from '@ryadom/ui/lib/utils'
import { useAuth, useClient } from '@/lib/auth'
import { FOCUS_RING } from './controls'
import Modal from './Modal'
import { Page } from './Page'
import {
  Busy,
  ModalActions,
  ModalText,
  ProfileButton,
  ROW,
  RowIcon,
  SettingsSection,
} from './ProfileParts'

/**
 * Account deletion (store requirements).
 *
 * Two confirmations in a row, a checkbox and a dialog: deletion cannot be undone and there is no
 * recovery. The listed consequences match exactly what the server does.
 */

const CONSEQUENCES: Array<{ icon: LucideIcon; text: string }> = [
  {
    icon: MessageSquareText,
    text: 'Разговоры, память обо мне и всё, что я знал о тебе, стираются у агента безвозвратно.',
  },
  {
    icon: UserX,
    text: 'Профиль и пароль удаляются. Восстановить аккаунт будет нельзя.',
  },
  {
    icon: Mail,
    text: 'Почта освободится: с ней можно будет зарегистрироваться заново — уже как новый человек.',
  },
]

export default function ProfileDeleteAccount() {
  const client = useClient()
  const router = useRouter()
  const { user, logout } = useAuth()
  const anonymous = user?.email === null
  // An anonymous account has no password to delete and no address to free.
  const consequences = anonymous
    ? CONSEQUENCES.filter((item) => item.icon !== Mail).map((item) =>
        item.icon === UserX
          ? { ...item, text: 'Профиль удаляется. Восстановить аккаунт будет нельзя.' }
          : item,
      )
    : CONSEQUENCES
  const [confirmed, setConfirmed] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const consentId = useId()

  async function runDeletion() {
    // aria-busy does not stop the keyboard: Enter on the busy button still clicks it.
    if (loading) return
    setConfirmOpen(false)
    setError('')
    setLoading(true)
    try {
      await client.deleteAccount()
      // The account is gone, and with it the device's claim on it: a later anonymous sign-in must start fresh.
      await client.forgetDevice()
      // Drop the tokens before anything else: the server will not refresh them any more, so a
      // request made while the message is on screen would only bounce. The signed-in shell stays
      // mounted until the person answers the message, so it is not torn down under the dialog.
      await client.endSession()
      setDone(true)
    } catch (err) {
      const reason = apiErrorText(
        err,
        { byStatus: { 503: 'Не удалось стереть разговоры — аккаунт на месте' } },
        'Не получилось удалить аккаунт',
      )
      setError(`${reason}. Попробуй чуть позже.`)
    } finally {
      setLoading(false)
    }
  }

  async function finish() {
    // An account with no confirmed address was opened by this device alone: with it gone, the person
    // is back at the start, not at a sign-in screen for an account they never had.
    const backToStart = user?.email === null || user?.isEmailConfirmed === false
    await logout()
    router.replace(backToStart ? '/welcome' : '/login')
  }

  return (
    <Page title="Удаление аккаунта" back={{ href: '/profile', label: 'Профиль' }} measure="form">
      {/* A statement of fact, not an alert: it must not be announced the moment the screen opens. */}
      <DangerNote title="Это действие необратимо" role={undefined}>
        {anonymous ? (
          'Удаляется аккаунт без регистрации и всё, что связано с ним.'
        ) : (
          <>
            Удаляется аккаунт{' '}
            {/* An address in running text: wrap it as one piece instead of breaking at a hyphen. */}
            <b className="inline-block max-w-full wrap-anywhere text-foreground">{user?.email ?? ''}</b> и всё,
            что связано с ним.
          </>
        )}
      </DangerNote>

      <SettingsSection title="Что произойдёт" testId="consequences">
        {consequences.map((item) => (
          <li key={item.text}>
            <Item
              className={cn(ROW, 'min-h-0 items-start text-[0.9375rem] leading-normal font-normal text-dim')}
            >
              {/* Down by half the difference between the glyph and the first line of text. */}
              <RowIcon icon={item.icon} className="mt-0.5" />
              <ItemContent>{item.text}</ItemContent>
            </Item>
          </li>
        ))}
      </SettingsSection>

      <Card data-testid="consents" className="gap-0 rounded-lg py-3">
        <CardContent className="px-4">
          <Field orientation="horizontal" role={undefined} className="min-h-11 items-start gap-3 py-2.5">
            <Checkbox
              id={consentId}
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked === true)}
              // The shared checkbox keys its checked look off data-checked, which Radix does not set. In
              // forced-colors mode a button's fill is forced to Canvas, so the checked box opts out of
              // the adjustment to get the Highlight fill and tick the old native box had (`dark:` because
              // the shared checkbox sets its fill under it too). The tick is as heavy as the old one.
              className={cn(
                FOCUS_RING,
                'cursor-pointer rounded-[8px] border-2 bg-surface data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground [&_svg]:stroke-[3.75] forced-colors:data-[state=checked]:border-[Highlight] dark:forced-colors:data-[state=checked]:bg-[Highlight] forced-colors:data-[state=checked]:text-[HighlightText] forced-colors:data-[state=checked]:forced-color-adjust-none',
              )}
            />
            <FieldLabel
              htmlFor={consentId}
              className="cursor-pointer text-base leading-[1.45] font-normal text-foreground"
            >
              Я понимаю последствия и хочу удалить аккаунт
            </FieldLabel>
          </Field>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {error && (
          <DangerNote title="Удаление не выполнено" data-testid="form-error">
            {error}
          </DangerNote>
        )}
        <ProfileButton
          type="button"
          variant="danger"
          className="w-full"
          data-testid="delete-account"
          // Not `disabled` while loading: the confirm dialog hands focus back to this button as it closes,
          // and a button that turns disabled drops it, so the next Tab would start over at the skip link.
          disabled={!confirmed}
          aria-busy={loading || undefined}
          onClick={() => {
            if (!loading) setConfirmOpen(true)
          }}
        >
          <Busy on={loading} />
          Удалить аккаунт
        </ProfileButton>
        <p className="text-center text-xs leading-normal text-balance text-faint">
          Передумал(а)? Просто вернись назад — без нажатия кнопки ничего не удаляется.
        </p>
      </div>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Удалить аккаунт?">
        <ModalText>Аккаунт и все разговоры будут удалены навсегда. Отменить это нельзя.</ModalText>
        {/* Cancel comes first, so the dialog opens with the safe answer focused. */}
        <ModalActions>
          <ProfileButton type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
            Отмена
          </ProfileButton>
          <ProfileButton
            type="button"
            variant="danger"
            data-testid="delete-confirm"
            onClick={() => void runDeletion()}
          >
            ОК
          </ProfileButton>
        </ModalActions>
      </Modal>

      {/* Not dismissible: the only way on is the button, which leaves for the sign-in screen. */}
      <Modal open={done} onClose={() => {}} title="Готово" dismissible={false}>
        <ModalText data-testid="deleted-message">Аккаунт и все разговоры удалены. Береги себя.</ModalText>
        <ProfileButton
          type="button"
          className="w-full"
          data-testid="deleted-ok"
          onClick={() => void finish()}
        >
          ОК
        </ProfileButton>
      </Modal>
    </Page>
  )
}

function DangerNote({
  title,
  children,
  ...props
}: Omit<ComponentProps<typeof Alert>, 'title' | 'children'> & { title: string; children: ReactNode }) {
  return (
    <Alert
      variant="destructive"
      className="gap-y-1 px-5 py-4 has-[>svg]:gap-x-3 *:data-[slot=alert-description]:text-dim *:[svg]:translate-y-px"
      {...props}
    >
      <TriangleAlert className="size-[22px] p-px" strokeWidth={2} aria-hidden="true" />
      <AlertTitle className="font-bold">{title}</AlertTitle>
      <AlertDescription className="min-w-0 text-[0.9375rem] leading-normal text-wrap wrap-break-word md:text-wrap">
        {children}
      </AlertDescription>
    </Alert>
  )
}
