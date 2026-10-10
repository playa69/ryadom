import { Block, Button, List, ListInput, Navbar, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState, type ChangeEvent } from 'react'
import { RegisterApiErrorCode } from '@ryadom/contracts/api/auth/register'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { outcomeFromCode, outcomeFromError, reportForm } from '../../../lib/analytics'
import { apiErrorText, codeText, register } from '../../../lib/api'
import { nameProblem, passwordProblem } from '../../../lib/validation'
import ConsentList, { NO_CONSENT, allConsented } from '../../ConsentList'
import PasswordInput from '../../PasswordInput'

/**
 * Registration by email and password. No session is issued here: signing in opens up only after
 * the code from the email is entered, so on success the screen goes to code entry.
 *
 * The password is passed along in the navigation state: the person typed it a moment ago, and
 * asking for it again right after confirmation is a needless step. It is never stored.
 */

const REGISTER_ERRORS: Record<RegisterApiErrorCode, string> = {
  [RegisterApiErrorCode.USER_ALREADY_EXISTS]: 'С этой почтой уже есть аккаунт. Войди или смени пароль',
  [RegisterApiErrorCode.DISPOSABLE_EMAIL]: 'Такую почту мы не принимаем — укажи постоянный адрес',
}

const REGISTER_FALLBACK = 'Не получилось создать аккаунт. Попробуй ещё раз'

export default function RegisterPage({ f7router }: { f7router: Router.Router }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [consent, setConsent] = useState(NO_CONSENT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleRegister() {
    const invalid = (message: string) => {
      reportForm('register', 'invalid')
      setError(message)
    }
    const trimmedEmail = email.trim().toLowerCase()
    const nameError = nameProblem(name)
    if (nameError) return invalid(nameError)
    if (!trimmedEmail || !password) return invalid('Введи почту и пароль')
    const problem = passwordProblem(password)
    if (problem) return invalid(problem)
    if (!allConsented(consent)) return invalid('Без всех трёх согласий аккаунт не создать')

    setError('')
    setLoading(true)
    try {
      const result = await register(trimmedEmail, password, name.trim())
      if (!result.ok) {
        reportForm('register', outcomeFromCode(result.code))
        setError(codeText(REGISTER_ERRORS, result.code, REGISTER_FALLBACK))
        return
      }
      reportForm('register', 'success')
      // The agreement is recorded once the code is entered and the session starts: only then is there
      // an account to record it for.
      f7router.navigate('/confirm-email/', { props: { email: result.data.email, password, consented: true } })
    } catch (err) {
      reportForm('register', outcomeFromError(err))
      setError(
        apiErrorText(
          err,
          { byStatus: { 422: `Проверь почту, имя и пароль (от ${InputLimit.PasswordMin} символов)` } },
          REGISTER_FALLBACK,
        ),
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page name="register" className="rd-page-auth">
      <Navbar backLink="Назад" transparent />
      <div className="rd-auth-head">
        <h1 className="rd-title">Давай знакомиться</h1>
        <p className="rd-muted">Аккаунт нужен, чтобы разговоры оставались твоими и не терялись.</p>
      </div>

      <List form className="rd-form">
        <ListInput
          label="Как тебя называть"
          name="name"
          type="text"
          value={name}
          outline
          floatingLabel
          clearButton
          maxlength={InputLimit.NameMax}
          autocomplete="given-name"
          autocapitalize="words"
          onInput={(event: ChangeEvent<HTMLInputElement>) => {
            setName(event.target.value)
            setError('')
          }}
        />
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
          label="Пароль"
          name="password"
          value={password}
          autocomplete="new-password"
          info={`Не меньше ${InputLimit.PasswordMin} символов`}
          onChange={(value) => {
            setPassword(value)
            setError('')
          }}
        />
      </List>

      {/* Consent is given explicitly: being 18+, the disclaimer, personal data processing (152-FZ). */}
      <ConsentList
        value={consent}
        onChange={(next) => {
          setConsent(next)
          setError('')
        }}
      />

      <Block className="rd-form-actions">
        {error && <p className="rd-form-error" data-testid="form-error">{error}</p>}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleRegister()}>
          Создать аккаунт
        </Button>
      </Block>
    </Page>
  )
}
