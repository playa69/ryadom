import {
  Block,
  BlockTitle,
  Button,
  Icon,
  List,
  ListItem,
  Navbar,
  Page,
  Preloader,
  f7,
} from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionApiResponse } from '@ryadom/contracts/api/auth/sessions'
import { sessionIsPhone, sessionLastSeen, sessionTitle } from '@ryadom/client-core/sessions'
import { apiErrorText, listSessions, revokeSession, signOutEverywhere } from '../../../lib/api'
import { useAuth } from '../../../lib/store'

/**
 * The devices the person is signed in on: this one, then the others with a button to end each, and
 * the two bulk actions (end all the others; sign out everywhere, this one included).
 *
 * What a session shows is what the device said about itself, so it is a way to recognise one's own
 * phone and not proof of who is on the other end: the note says to change the password too.
 */

const LOAD_FALLBACK = 'Не получилось загрузить устройства'

const iconOf = (session: SessionApiResponse) =>
  sessionIsPhone(session) ? 'device_phone_portrait' : 'device_desktop'

export default function SessionsPage({ f7router }: { f7router: Router.Router }) {
  const { logout } = useAuth()
  const [sessions, setSessions] = useState<SessionApiResponse[] | null>(null)
  const [error, setError] = useState('')
  const [endingId, setEndingId] = useState<string | null>(null)
  // A load that was started before a newer one must not overwrite what the newer one brought.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await listSessions()
      if (mine !== generation.current) return
      setSessions(next)
      setError('')
    } catch (err) {
      if (mine !== generation.current) return
      setError(apiErrorText(err, {}, LOAD_FALLBACK))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toast = (text: string) => f7.toast.create({ text, closeTimeout: 2000 }).open()

  async function endOne(session: SessionApiResponse) {
    if (endingId) return
    setEndingId(session.id)
    try {
      // "Not found" is where the person wanted the session to be: it is gone already.
      await revokeSession(session.id)
      toast('Сессия завершена')
      await load()
    } catch (err) {
      toast(apiErrorText(err, {}, 'Не получилось завершить сессию. Попробуй ещё раз'))
    } finally {
      setEndingId(null)
    }
  }

  function endOthers() {
    f7.dialog.confirm(
      'Остальные устройства выйдут из аккаунта и спросят вход заново. Это устройство останется. Выход на них может занять до 15 минут.',
      'Завершить остальные сессии',
      () => {
        void signOutEverywhere(true)
          .then(() => {
            toast('Остальные сессии завершены')
            return load()
          })
          .catch((err: unknown) =>
            toast(apiErrorText(err, {}, 'Не получилось завершить сессии. Попробуй ещё раз')),
          )
      },
    )
  }

  function endAll() {
    f7.dialog.confirm(
      'Аккаунт выйдет на всех устройствах, включая это. Чтобы вернуться, понадобится войти заново.',
      'Выйти на всех устройствах',
      () => {
        // The server ends this session too; the phone then forgets it, and the app shows the sign-in.
        void signOutEverywhere(false)
          .then(() => logout())
          .catch((err: unknown) => toast(apiErrorText(err, {}, 'Не получилось выйти. Попробуй ещё раз')))
      },
    )
  }

  const current = sessions?.find((session) => session.current) ?? null
  const others = sessions?.filter((session) => !session.current) ?? []

  return (
    <Page name="sessions">
      <Navbar backLink="Профиль" title="Устройства и сессии" />

      {sessions === null && !error && (
        <Block className="text-align-center">
          <Preloader />
        </Block>
      )}

      {sessions === null && error && (
        <div className="rd-empty">
          <p className="rd-form-error" data-testid="form-error">
            {error}
          </p>
          <Button round outline className="rd-empty-action" onClick={() => void load()}>
            Попробовать ещё раз
          </Button>
        </div>
      )}

      {sessions !== null && (
        <>
          {current && (
            <>
              <BlockTitle>Это устройство</BlockTitle>
              <List inset strong dividers className="rd-menu" data-testid="sessions-current">
                <ListItem
                  className="rd-wrap"
                  title={sessionTitle(current)}
                  footer="Это устройство"
                  data-testid="session-row"
                >
                  <Icon slot="media" f7={iconOf(current)} />
                </ListItem>
              </List>
            </>
          )}

          <BlockTitle>Другие устройства</BlockTitle>
          {others.length === 0 ? (
            <Block>
              <p className="rd-caption" data-testid="sessions-none">
                Других устройств нет.
              </p>
            </Block>
          ) : (
            <>
              <List inset strong dividers className="rd-menu" data-testid="sessions-others">
                {others.map((session) => (
                  <ListItem
                    key={session.id}
                    // A long name ("Приложение для Android") wraps instead of being cut by the button beside it.
                    className="rd-wrap"
                    title={sessionTitle(session)}
                    footer={`Была активна ${sessionLastSeen(session.lastUsedAt)}`}
                    data-testid="session-row"
                  >
                    <Icon slot="media" f7={iconOf(session)} />
                    <Button
                      slot="after"
                      small
                      outline
                      round
                      preloader
                      loading={endingId === session.id}
                      disabled={endingId !== null}
                      data-testid="session-end"
                      aria-label={`Завершить сессию: ${sessionTitle(session)}`}
                      onClick={() => void endOne(session)}
                    >
                      Завершить
                    </Button>
                  </ListItem>
                ))}
              </List>
              <Block>
                <p className="rd-caption">
                  Не узнаёшь устройство? Заверши его и смени пароль, чтобы им не воспользовались снова: смена
                  пароля завершает и остальные сессии.
                </p>
              </Block>
            </>
          )}

          {error && (
            <Block>
              <p className="rd-form-error" data-testid="form-error">
                {error}
              </p>
            </Block>
          )}

          <Block className="rd-form-actions">
            {others.length > 0 && (
              <Button large outline data-testid="end-others" onClick={endOthers}>
                Завершить остальные сессии
              </Button>
            )}
            <Button large outline data-testid="end-all" onClick={endAll}>
              Выйти на всех устройствах
            </Button>
          </Block>
        </>
      )}
    </Page>
  )
}
