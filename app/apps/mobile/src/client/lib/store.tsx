import { identify, reconcileOptOut, resetIdentity } from '@ryadom/analytics/browser'
import { accountKindOf } from '@ryadom/analytics/events'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthTokensApiResponse } from '@ryadom/contracts/api/auth/shared'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { acceptConsents, forgetDevice, getCurrentUser, setSessionEndHandler, updateProfile } from './api'
import {
  endSession as clearSession,
  restoreSession,
  saveUser,
  signOut,
  startSession,
  type User,
} from './auth'
import { journal } from './journal'
import { resetMemoryState } from './memory'
import { markTelegramSignedOut } from './telegram'

/**
 * The app session. The refresh token is read from secure storage asynchronously, so until it has
 * been read the state is `restoring` and the splash screen stays up.
 */

/** The screen a person without a session meets first: a new visitor the first screen, a returning one the sign-in. */
export type Entry = 'welcome' | 'login'

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  /** The session is still being read from storage: too early to show the sign-in screen. */
  restoring: boolean
  entry: Entry
}

/** What a sign-in may record on the way: the agreements the person has just given on a screen. */
export interface LoginOptions {
  /** The person ticked everything on this screen: record it for the account the session is for. */
  consent?: boolean
}

interface AuthContextType {
  auth: AuthState
  login: (user: User, tokens: AuthTokensApiResponse, options?: LoginOptions) => Promise<void>
  /** Records the agreements for the signed-in account; false when the server did not take them. */
  acceptConsents: () => Promise<boolean>
  /**
   * Ends the session: the sign-out button, an environment switch, and every server-side teardown.
   * With `entry: 'welcome'` the next screen is the first one (an account that was just erased).
   */
  logout: (options?: { entry?: Entry }) => Promise<void>
  /**
   * Leaves an account that has no way back in other than this phone, for the sign-in screen. The
   * device is forgotten with it: otherwise the next launch would walk straight back into the
   * account that was just left.
   */
  leaveAnonymousAccount: () => Promise<void>
  updateUser: (updates: Partial<User>) => void
}

const ANONYMOUS: AuthState = { user: null, isAuthenticated: false, restoring: false, entry: 'welcome' }

async function loadInitialAuth(): Promise<AuthState> {
  const user = await restoreSession()
  return user ? { user, isAuthenticated: true, restoring: false, entry: 'welcome' } : ANONYMOUS
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ ...ANONYMOUS, restoring: true })

  useEffect(() => {
    let cancelled = false
    loadInitialAuth()
      .catch(() => ANONYMOUS)
      .then((initial) => {
        if (!cancelled) setAuth(initial)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (user: User, tokens: AuthTokensApiResponse, options: LoginOptions = {}) => {
    markTelegramSignedOut(false)
    await startSession(user, tokens)
    journal.reset()
    resetMemoryState()
    let current = user
    if (options.consent) {
      // Before the app learns it is signed in, so that its gate does not ask for what is just being
      // recorded. A failure is not fatal: the gate asks again, and the server refuses a conversation
      // in the meantime.
      const outcome = await acceptConsents().catch(() => null)
      if (outcome?.ok) {
        current = { ...user, consentVersion: POLICY_VERSION }
        await saveUser(current)
      }
    }
    setAuth({ user: current, isAuthenticated: true, restoring: false, entry: 'login' })
  }, [])

  /**
   * The only way a session ends: an explicit sign-out, a rejected refresh, an "account deleted or
   * blocked" response, or an environment switch. A person whose session ended had an account, so the
   * sign-in is where they land (an anonymous one is signed back in before that screen shows).
   */
  const endSession = useCallback(async () => {
    await clearSession()
    journal.reset()
    resetMemoryState()
    setAuth({ ...ANONYMOUS, entry: 'login' })
  }, [])

  /**
   * The person signs out: the server ends the session first, then the same teardown. Inside Telegram the
   * next screen would sign them straight back in, so this launch of the Mini App remembers they left.
   */
  const logout = useCallback(async (options: { entry?: Entry } = {}) => {
    markTelegramSignedOut(true)
    await signOut()
    journal.reset()
    resetMemoryState()
    setAuth({ ...ANONYMOUS, entry: options.entry ?? 'login' })
  }, [])

  const leaveAnonymousAccount = useCallback(async () => {
    markTelegramSignedOut(true)
    await signOut()
    await forgetDevice()
    journal.reset()
    resetMemoryState()
    setAuth({ ...ANONYMOUS, entry: 'login' })
  }, [])

  // Who the analytics events belong to: set for a sign-in, a restored session and a change of the account's
  // kind (an address linked); cleared when the session ends, however it ends. The id, never the email.
  const userId = auth.user?.id ?? null
  const kind = auth.user ? accountKindOf(auth.user) : null
  const identified = useRef(false)
  useEffect(() => {
    if (userId && kind) {
      identify(userId, { account_kind: kind })
      identified.current = true
    } else if (identified.current) {
      identified.current = false
      resetIdentity()
    }
  }, [userId, kind])

  // A "no" is the account's, not the device's: after sign-in the two are brought together, so that opting
  // out on one device silences the others and a "no" said before signing in reaches the server. The stored
  // user has no such field, hence one read of the profile per signed-in account.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    getCurrentUser()
      .then((me) => {
        if (cancelled) return
        return reconcileOptOut(me.analyticsOptOut, (optOut) => updateProfile({ analyticsOptOut: optOut }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [userId])

  // The API layer cannot import the store (that would be a cycle), so it uses this subscription.
  useEffect(() => {
    setSessionEndHandler(() => void endSession())
    return () => setSessionEndHandler(null)
  }, [endSession])

  const updateUser = useCallback((updates: Partial<User>) => {
    setAuth((prev) => {
      if (!prev.user) return prev
      const updated = { ...prev.user, ...updates }
      void saveUser(updated)
      return { ...prev, user: updated }
    })
  }, [])

  const accept = useCallback(async () => {
    const outcome = await acceptConsents().catch(() => null)
    if (!outcome?.ok) return false
    updateUser({ consentVersion: POLICY_VERSION })
    return true
  }, [updateUser])

  return (
    <AuthContext.Provider
      value={{ auth, login, acceptConsents: accept, logout, leaveAnonymousAccount, updateUser }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
