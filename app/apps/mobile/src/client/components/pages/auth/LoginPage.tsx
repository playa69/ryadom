import { Block, Button, Link, List, ListInput, Page, f7 } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState, type ChangeEvent } from 'react'
import { apiErrorText, login } from '../../../lib/api'
import { openExternal, privacyUrl, termsUrl } from '../../../lib/links'
import { useAuth } from '../../../lib/store'
import { useEnvSwitcherTaps } from '../../../lib/use-env-switcher'
import { BrandMark } from '../../Brand'
import PasswordInput from '../../PasswordInput'

/**
 * Sign-in by email and password. The first screen without a session.
 *
 * The server does not say why it refused, so the sign-in help lists every case at
 * once: the same text for everyone, revealing nothing.
 */
export default function LoginPage({ f7router }: { f7router: Router.Router }) {
  const { login: storeLogin } = useAuth()
  // Entry to the env picker (dev build): taps on the mark, reachable even when the server is down.
  const onLogoTap = useEnvSwitcherTaps()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin() {
    if (!email.trim() || !password) {
      setError('Введи почту и пароль')
      return
    }
    setError('')
    setLoading(true)
    try {
      const { user, tokens } = await login(email.trim().toLowerCase(), password)
      await storeLogin(user, tokens)
    } catch (err) {
      setError(apiErrorText(err, { byStatus: { 401: 'Неверная почта или пароль' } }, 'Не получилось войти'))
    } finally {
      setLoading(false)
    }
  }

  function showLoginHelp() {
    f7.dialog
      .create({
        title: 'Не получается войти',
        text: [
          '<b>Не подтвердил(а) почту?</b> Войти можно только после ввода кода из письма. Зарегистрируйся заново с тем же адресом&nbsp;— мы пришлём новый код.',
          '<b>Не помнишь пароль?</b> Нажми «Не помню пароль» — пришлём код для смены.',
          '<b>Письмо не приходит?</b> Загляни в «Спам».',
        ].join('<br><br>'),
        buttons: [{ text: 'Понятно', close: true }],
      })
      .open()
  }

  return (
    <Page name="login" className="rd-page-auth">
      <div className="rd-auth-head rd-auth-head--top">
        <div className="rd-auth-orb" aria-hidden="true" />
        <button type="button" className="rd-logo-button" onClick={onLogoTap} aria-label="Рядом">
          <BrandMark size={56} />
        </button>
        <h1 className="rd-title rd-title--lg">Рядом</h1>
        <p className="rd-muted">Когда нужно, чтобы кто-то был рядом.</p>
      </div>

      <List
        form
        className="rd-form"
        onSubmit={(event) => {
          event.preventDefault()
          void handleLogin()
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
          label="Пароль"
          name="password"
          value={password}
          autocomplete="current-password"
          onChange={(value) => {
            setPassword(value)
            setError('')
          }}
        />
        {/* Enter in a field submits the form: with two fields the browser only does that when the
            form contains a type="submit" button. */}
        <button type="submit" className="rd-submit-hidden" tabIndex={-1} aria-hidden="true" />
      </List>

      <Block className="rd-form-actions">
        {error && <p className="rd-form-error" data-testid="form-error">{error}</p>}
        <Button fill large preloader loading={loading} disabled={loading} onClick={() => void handleLogin()}>
          Войти
        </Button>
        <Button large outline onClick={() => f7router.navigate('/register/')} disabled={loading}>
          Создать аккаунт
        </Button>
        <div className="rd-links">
          <Link onClick={() => f7router.navigate('/forgot-password/')}>Не помню пароль</Link>
          <Link onClick={showLoginHelp}>Не получается войти?</Link>
          {/* The way to the first screen, for someone who came here by mistake or is new. */}
          <Link onClick={() => f7router.navigate('/welcome/')} data-testid="start-anonymously">
            Начать без регистрации
          </Link>
        </div>

        <p className="rd-fineprint">
          Продолжая, ты соглашаешься с{' '}
          <a
            href="#"
            className="rd-inline-link"
            onClick={(event) => {
              event.preventDefault()
              void openExternal(termsUrl())
            }}
          >
            условиями
          </a>{' '}
          и{' '}
          <a
            href="#"
            className="rd-inline-link"
            onClick={(event) => {
              event.preventDefault()
              void openExternal(privacyUrl())
            }}
          >
            политикой обработки персональных данных
          </a>
          . Только 18+. Это сервис самоподдержки, не психотерапия.
        </p>
      </Block>
    </Page>
  )
}
