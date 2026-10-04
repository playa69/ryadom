'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { RefreshApiErrorCode } from '@ryadom/contracts/api/auth/refresh'
import type { AuthTokensApiResponse } from '@ryadom/contracts/api/auth/shared'
import type { RyadomClient } from '@ryadom/client-core/client'
import type { User } from '@ryadom/client-core/storage'
import { createWebClient } from './client'

export type AuthStatus = 'restoring' | 'anonymous' | 'authenticated'

export interface AuthValue {
  status: AuthStatus
  user: User | null
  /** Why the person was signed out against their will; the login screen shows it. */
  notice: string | null
  dismissNotice(): void
  login(email: string, password: string): Promise<void>
  /** Sign-in without an email: the first call on this device makes the account, later ones return it. */
  continueAnonymously(): Promise<void>
  logout(): Promise<void>
  updateUser(partial: Partial<User>): void
  /** For flows that obtain tokens themselves (e.g. right after confirming an email). */
  completeSession(user: User, tokens: AuthTokensApiResponse): Promise<void>
}

const ClientContext = createContext<RyadomClient | null>(null)
const AuthContext = createContext<AuthValue | null>(null)

const DELETED_TEXT = 'Этот аккаунт удалён, поэтому мы вышли из него на этом устройстве.'
const BLOCKED_TEXT = 'Этот аккаунт заблокирован, поэтому мы вышли из него на этом устройстве.'

export function AuthProvider({ apiBase, children }: { apiBase: string; children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('restoring')
  const [user, setUser] = useState<User | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The client is built once but its callbacks must see current state setters.
  const handlers = useRef({
    onSessionEnd: () => {
      setUser(null)
      setStatus('anonymous')
    },
    onAccountUnavailable: (code: RefreshApiErrorCode) =>
      setNotice(code === RefreshApiErrorCode.ACCOUNT_DELETED ? DELETED_TEXT : BLOCKED_TEXT),
  })
  const [client] = useState(() => createWebClient(apiBase, () => handlers.current))

  useEffect(() => {
    let cancelled = false
    client
      .restoreSession()
      .catch(() => null)
      .then((restored) => {
        if (cancelled) return
        setUser(restored)
        setStatus(restored ? 'authenticated' : 'anonymous')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  // The refresh token is shared by every tab of this browser. When another tab signs out or in as
  // someone else, this one must not keep showing (or fetching) the previous account's data.
  useEffect(() => {
    const revalidate = () => void client.revalidateSession()
    const onVisible = () => {
      if (document.visibilityState === 'visible') revalidate()
    }
    window.addEventListener('storage', revalidate)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('storage', revalidate)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [client])

  const completeSession = useCallback(
    async (next: User, tokens: AuthTokensApiResponse) => {
      await client.startSession(next, tokens)
      setNotice(null)
      setUser(next)
      setStatus('authenticated')
    },
    [client],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await client.login(email, password)
      await completeSession(result.user, result.tokens)
    },
    [client, completeSession],
  )

  const continueAnonymously = useCallback(async () => {
    const result = await client.deviceLogin()
    await completeSession(result.user, result.tokens)
  }, [client, completeSession])

  const logout = useCallback(async () => {
    await client.signOut()
    setUser(null)
    setStatus('anonymous')
  }, [client])

  const updateUser = useCallback(
    (partial: Partial<User>) => {
      setUser((prev) => {
        if (!prev) return prev
        const next = { ...prev, ...partial }
        void client.saveUser(next)
        return next
      })
    },
    [client],
  )

  const dismissNotice = useCallback(() => setNotice(null), [])

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      notice,
      dismissNotice,
      login,
      continueAnonymously,
      logout,
      updateUser,
      completeSession,
    }),
    [status, user, notice, dismissNotice, login, continueAnonymously, logout, updateUser, completeSession],
  )

  return (
    <ClientContext.Provider value={client}>
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    </ClientContext.Provider>
  )
}

export function useClient(): RyadomClient {
  const ctx = useContext(ClientContext)
  if (!ctx) throw new Error('useClient must be used inside Providers')
  return ctx
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside Providers')
  return ctx
}
