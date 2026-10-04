'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import { apiErrorText } from '@ryadom/client-core/errors'
import { Alert } from '@ryadom/ui/components/alert'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import Modal from '@/components/Modal'
import { useAuth } from '@/lib/auth'
import { useAuthFlow } from '../auth-flow'
import { TextField, PasswordField } from '../_components/fields'
import { FOCUS_RING } from '../_components/focus'
import {
  AuthActions,
  AuthForm,
  AuthHead,
  ExternalLink,
  FinePrint,
  FormError,
  LINK_BUTTON,
  Muted,
  OUTLINE_BUTTON,
  PRIMARY_BUTTON,
  SubmitButton,
  focusField,
  type Problem,
} from '../_components/parts'

/**
 * Sign-in by email and password. The server does not say why it refused, so the help lists every
 * case at once: the same text for everyone, revealing nothing.
 */
export default function LoginScreen() {
  const { login, notice, dismissNotice } = useAuth()
  const { termsUrl, privacyUrl } = useAuthFlow()
  const formRef = useRef<HTMLFormElement>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  function refuse(text: string, field: string) {
    setProblem({ text, field })
    focusField(formRef.current, field)
  }

  async function submit() {
    if (loading) return
    const address = email.trim().toLowerCase()
    if (!address) return refuse('Введи почту и пароль', 'email')
    if (!password) return refuse('Введи почту и пароль', 'password')

    setProblem(null)
    setLoading(true)
    try {
      // On success the (auth) frame sees the session and moves on to /home.
      await login(address, password)
    } catch (err) {
      setProblem({
        text: apiErrorText(err, { byStatus: { 401: 'Неверная почта или пароль' } }, 'Не получилось войти'),
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {notice && (
        // The notice after a forced sign-out; it can be dismissed. The close button reaches into the
        // corner of the box so it keeps a 44px target without making the box taller.
        <Alert role="status" className="flex items-start gap-2">
          <p className="min-w-0 flex-1 py-2">{notice}</p>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('-my-3 -mr-4 shrink-0 cursor-pointer border-0 hover:bg-transparent', FOCUS_RING)}
            aria-label="Закрыть"
            onClick={dismissNotice}
          >
            <XIcon className="size-[18px]" strokeWidth={1.8} />
          </Button>
        </Alert>
      )}

      <AuthHead title="Вход" hideTitle>
        Когда нужно, чтобы кто-то был рядом.
      </AuthHead>

      <AuthForm formRef={formRef} onSubmit={() => void submit()}>
        <TextField
          label="Почта"
          name="email"
          type="email"
          value={email}
          autoComplete="username"
          inputMode="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          invalid={problem?.field === 'email'}
          focusOnFinePointer
          onChange={(value) => {
            setEmail(value)
            setProblem(null)
          }}
        />
        <PasswordField
          label="Пароль"
          name="password"
          value={password}
          autoComplete="current-password"
          required
          invalid={problem?.field === 'password'}
          onChange={(value) => {
            setPassword(value)
            setProblem(null)
          }}
        />

        <AuthActions>
          <FormError problem={problem} />
          <SubmitButton loading={loading}>Войти</SubmitButton>
          <Button asChild variant="outline" className={OUTLINE_BUTTON}>
            <Link href="/register">Создать аккаунт</Link>
          </Button>
        </AuthActions>

        {/* Links in a row get the full touch height, which an inline link does not have. */}
        <div className="flex flex-wrap justify-center gap-x-5">
          <Button asChild variant="link" size="sm" className={LINK_BUTTON}>
            <Link href="/forgot-password">Не помню пароль</Link>
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            className={LINK_BUTTON}
            aria-haspopup="dialog"
            onClick={() => setHelpOpen(true)}
          >
            Не получается войти?
          </Button>
          {/* The way to the first screen, for someone who came here by mistake or is new. */}
          <Button asChild variant="link" size="sm" className={LINK_BUTTON}>
            <Link href="/welcome" data-testid="start-anonymously">
              Начать без регистрации
            </Link>
          </Button>
        </div>
      </AuthForm>

      <FinePrint>
        Продолжая, ты соглашаешься с <ExternalLink href={termsUrl}>условиями</ExternalLink> и{' '}
        <ExternalLink href={privacyUrl}>политикой обработки персональных данных</ExternalLink>. Только 18+.
        Это сервис самоподдержки, не психотерапия.
      </FinePrint>

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="Не получается войти">
        <Muted>
          <b>Не подтвердил(а) почту?</b> Войти можно только после ввода кода из письма. Зарегистрируйся заново
          с тем же адресом&nbsp;— мы пришлём новый код.
        </Muted>
        <Muted>
          <b>Не помнишь пароль?</b> Нажми «Не помню пароль» — пришлём код для смены.
        </Muted>
        <Muted>
          <b>Письмо не приходит?</b> Загляни в «Спам».
        </Muted>
        <Button type="button" className={PRIMARY_BUTTON} onClick={() => setHelpOpen(false)}>
          Понятно
        </Button>
      </Modal>
    </>
  )
}
