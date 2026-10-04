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
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import type { RyadomClient } from '@ryadom/client-core/client'
import type { User } from '@ryadom/client-core/storage'
import { createWebClient } from './client'

export type AuthStatus = 'restoring' | 'anonymous' | 'authenticated'

/** What a sign-in may record on the way: the agreements the person has just given on a screen. */
export interface SessionOptions {
  /** The person ticked everything on this screen: record it for the account the session is for. */
  consent?: boolean
}

export interface AuthValue {
  status: AuthStatus
  user: User | null
  /** Why the person was signed out against their will; the login screen shows it. */
  notice: string | null
  dismissNotice(): void
  login(email: string, password: string, options?: SessionOptions): Promise<void>
  /**
   * Sign-in without an email: the first call on this device makes the account, later ones return it.
   * The first screen passes `consent`; a launch that finds the device already known does not.
   */
  startAnonymously(options?: SessionOptions): Promise<void>
  /** Records the agreements for the signed-in account; false when the server did not take them. */
  acceptConsents(): Promise<boolean>
  logout(): Promise<void>
  /**
   * Leaves an account that has no way back in other than this device, for the sign-in screen. The
   * device is forgotten with it: otherwise the next launch would walk straight back into the
   * account that was just left.
   */
  leaveAnonymousAccount(): Promise<void>
  updateUser(partial: Partial<User>): void
  /** For flows that obtain tokens themselves (e.g. right after confirming an email). */
  completeSession(user: User, tokens: AuthTokensApiResponse, options?: SessionOptions): Promise<void>
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
    async (next: User, tokens: AuthTokensApiResponse, options: SessionOptions = {}) => {
      await client.startSession(next, tokens)
      let current = next
      if (options.consent) {
        // Before the app learns it is signed in, so that its gate does not ask for what is just being
        // recorded. A failure is not fatal: the gate asks again, and the server refuses a conversation
        // in the meantime.
        const outcome = await client.acceptConsents().catch(() => null)
        if (outcome?.ok) {
          current = { ...next, consentVersion: POLICY_VERSION }
          await client.saveUser(current)
        }
      }
      setNotice(null)
      setUser(current)
      setStatus('authenticated')
    },
    [client],
  )

  const login = useCallback(
    async (email: string, password: string, options?: SessionOptions) => {
      const result = await client.login(email, password)
      await completeSession(result.user, result.tokens, options)
    },
    [client, completeSession],
  )

  const startAnonymously = useCallback(
    async (options?: SessionOptions) => {
      const result = await client.deviceLogin()
      await completeSession(result.user, result.tokens, options)
    },
    [client, completeSession],
  )

  const logout = useCallback(async () => {
    await client.signOut()
    setUser(null)
    setStatus('anonymous')
  }, [client])

  const leaveAnonymousAccount = useCallback(async () => {
    await client.signOut()
    await client.forgetDevice()
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

  const acceptConsents = useCallback(async () => {
    const outcome = await client.acceptConsents().catch(() => null)
    if (!outcome?.ok) return false
    updateUser({ consentVersion: POLICY_VERSION })
    return true
  }, [client, updateUser])

  const dismissNotice = useCallback(() => setNotice(null), [])

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      notice,
      dismissNotice,
      login,
      startAnonymously,
      acceptConsents,
      logout,
      leaveAnonymousAccount,
      updateUser,
      completeSession,
    }),
    [
      status,
      user,
      notice,
      dismissNotice,
      login,
      startAnonymously,
      acceptConsents,
      logout,
      leaveAnonymousAccount,
      updateUser,
      completeSession,
    ],
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
