'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, Smartphone } from 'lucide-react'
import type { SessionApiResponse } from '@ryadom/contracts/api/auth/sessions'
import { apiErrorText } from '@ryadom/client-core/errors'
import { sessionIsPhone, sessionLastSeen, sessionTitle } from '@ryadom/client-core/sessions'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { useAuth, useClient } from '@/lib/auth'
import { RetryButton, StatePanel } from './JournalParts'
import Modal from './Modal'
import { useNotice } from './Notice'
import { Page } from './Page'
import { Busy, ModalActions, ModalText, ProfileButton, RowIcon, SettingsSection } from './ProfileParts'

/**
 * The devices the person is signed in on: this one first, then the others with a button to end each,
 * and the two bulk actions: end all the others, or sign out everywhere, this device included.
 *
 * What a session shows is what the device said about itself, so it is a way to recognise one's own
 * phone and not proof of who is on the other end. A session that is not the person's is ended
 * with one press, and the person is told to change the password too: ending a session does not
 * change who knows it.
 */

const LOAD_FALLBACK = 'Не получилось загрузить устройства'

type Confirm = 'others' | 'all' | null

function SessionRow({ session, busy, onEnd }: { session: SessionApiResponse; busy: boolean; onEnd(): void }) {
  const title = sessionTitle(session)
  return (
    <li data-testid="session-row" data-current={session.current || undefined}>
      {/* One wrapper under the <li>: the card gives every direct child of a row the corner radius of
          the card, and a button there would be square in the middle of the list and round at its ends. */}
      <div className="flex items-center gap-3 px-4 py-3.5 tab:py-3">
        <RowIcon icon={sessionIsPhone(session) ? Smartphone : Monitor} className="mt-1 self-start" />
        <div className="min-w-0 flex-1">
          <p className="text-base leading-[1.35] font-medium wrap-break-word" data-testid="session-title">
            {title}
          </p>
          <p className="mt-0.5 text-[0.8125rem] leading-[1.4] text-dim">
            {session.current ? 'Это устройство' : `Была активна ${sessionLastSeen(session.lastUsedAt)}`}
          </p>
        </div>
        {!session.current && (
          <ProfileButton
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 px-4"
            aria-busy={busy || undefined}
            aria-label={`Завершить сессию: ${title}`}
            data-testid="session-end"
            onClick={onEnd}
          >
            <Busy on={busy} />
            Завершить
          </ProfileButton>
        )}
      </div>
    </li>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" role="status" aria-busy="true" data-testid="sessions-loading">
      <span className="sr-only">Загружаем устройства…</span>
      <Skeleton className="ml-1 h-3.5 w-24 motion-reduce:animate-none" />
      <div className="glass overflow-hidden rounded-lg" aria-hidden="true">
        <div className="flex flex-col gap-2 px-4 py-4">
          <Skeleton className="h-4 w-1/2 motion-reduce:animate-none" />
          <Skeleton className="h-3.5 w-1/3 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  )
}

export default function ProfileSessions() {
  const client = useClient()
  const router = useRouter()
  const notify = useNotice()
  const { logout } = useAuth()
  const [sessions, setSessions] = useState<SessionApiResponse[] | null>(null)
  const [error, setError] = useState('')
  const [endingId, setEndingId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [working, setWorking] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // A load that was started before a newer one must not overwrite what the newer one brought.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await client.listSessions()
      if (mine !== generation.current) return
      setSessions(next)
      setError('')
    } catch (err) {
      if (mine !== generation.current) return
      setError(apiErrorText(err, {}, LOAD_FALLBACK))
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  async function retry() {
    setRetrying(true)
    await load()
    setRetrying(false)
  }

  async function endOne(session: SessionApiResponse) {
    if (endingId) return
    setEndingId(session.id)
    try {
      // "Not found" is where the person wanted the session to be: it is gone already.
      await client.revokeSession(session.id)
      notify('Сессия завершена', 'success')
      await load()
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось завершить сессию. Попробуй ещё раз'), 'error')
    } finally {
      setEndingId(null)
    }
  }

  async function endOthers() {
    setWorking(true)
    try {
      await client.signOutEverywhere(true)
      setConfirm(null)
      notify('Остальные сессии завершены', 'success')
      await load()
    } catch (err) {
      setConfirm(null)
      notify(apiErrorText(err, {}, 'Не получилось завершить сессии. Попробуй ещё раз'), 'error')
    } finally {
      setWorking(false)
    }
  }

  async function endAll() {
    setWorking(true)
    try {
      await client.signOutEverywhere(false)
      // This device forgets its session too; the server has already ended it.
      await logout()
      router.replace('/login')
    } catch (err) {
      setConfirm(null)
      notify(apiErrorText(err, {}, 'Не получилось выйти. Попробуй ещё раз'), 'error')
    } finally {
      setWorking(false)
    }
  }

  const current = sessions?.find((session) => session.current) ?? null
  const others = sessions?.filter((session) => !session.current) ?? []

  return (
    <Page title="Устройства и сессии" back={{ href: '/profile', label: 'Профиль' }} data-testid="sessions">
      {sessions === null && !error && <ListSkeleton />}

      {sessions === null && error && (
        <StatePanel>
          <p className="text-[0.9375rem] leading-[1.4] text-danger" role="alert" data-testid="form-error">
            {error}
          </p>
          <RetryButton busy={retrying} onClick={() => void retry()} />
        </StatePanel>
      )}

      {sessions !== null && (
        <>
          {current && (
            <SettingsSection title="Это устройство" testId="sessions-current">
              <SessionRow session={current} busy={false} onEnd={() => {}} />
            </SettingsSection>
          )}

          <SettingsSection
            title="Другие устройства"
            testId="sessions-others"
            note={
              others.length > 0
                ? 'Не узнаёшь устройство? Заверши его и смени пароль, чтобы им не воспользовались снова: смена пароля завершает и остальные сессии.'
                : undefined
            }
          >
            {others.length === 0 ? (
              <li className="px-4 py-4 text-[0.9375rem] leading-[1.4] text-dim" data-testid="sessions-none">
                Других устройств нет.
              </li>
            ) : (
              others.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  busy={endingId === session.id}
                  onEnd={() => void endOne(session)}
                />
              ))
            )}
          </SettingsSection>

          {error && (
            <p className="text-[0.9375rem] leading-[1.4] text-danger" role="alert" data-testid="form-error">
              {error}
            </p>
          )}

          <div className="flex flex-col gap-3 tab:flex-row">
            {others.length > 0 && (
              <ProfileButton
                type="button"
                variant="outline"
                className="w-full tab:w-auto tab:px-6"
                data-testid="end-others"
                onClick={() => setConfirm('others')}
              >
                Завершить остальные сессии
              </ProfileButton>
            )}
            <ProfileButton
              type="button"
              variant="outline"
              className="w-full tab:w-auto tab:px-6"
              data-testid="end-all"
              onClick={() => setConfirm('all')}
            >
              Выйти на всех устройствах
            </ProfileButton>
          </div>
        </>
      )}

      <p className="sr-only" role="status">
        {sessions ? `Устройств: ${sessions.length}` : ''}
      </p>

      <Modal
        open={confirm === 'others'}
        onClose={() => setConfirm(null)}
        title="Завершить остальные сессии"
        dismissible={!working}
      >
        <ModalText>
          Остальные устройства выйдут из аккаунта и спросят вход заново. Это устройство останется. Выход на
          них может занять до 15 минут.
        </ModalText>
        <ModalActions>
          <ProfileButton type="button" variant="outline" disabled={working} onClick={() => setConfirm(null)}>
            Отмена
          </ProfileButton>
          <ProfileButton
            type="button"
            data-testid="end-others-confirm"
            aria-busy={working || undefined}
            onClick={() => void endOthers()}
          >
            <Busy on={working} />
            Завершить
          </ProfileButton>
        </ModalActions>
      </Modal>

      <Modal
        open={confirm === 'all'}
        onClose={() => setConfirm(null)}
        title="Выйти на всех устройствах"
        dismissible={!working}
      >
        <ModalText>
          Аккаунт выйдет на всех устройствах, включая это. Чтобы вернуться, понадобится войти заново.
        </ModalText>
        <ModalActions>
          <ProfileButton type="button" variant="outline" disabled={working} onClick={() => setConfirm(null)}>
            Отмена
          </ProfileButton>
          <ProfileButton
            type="button"
            data-testid="end-all-confirm"
            aria-busy={working || undefined}
            onClick={() => void endAll()}
          >
            <Busy on={working} />
            Выйти
          </ProfileButton>
        </ModalActions>
      </Modal>
    </Page>
  )
}
