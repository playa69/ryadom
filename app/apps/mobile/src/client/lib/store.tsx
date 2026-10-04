import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { AuthTokensApiResponse } from '@ryadom/contracts/api/auth/shared'
import { setSessionEndHandler } from './api'
import {
  endSession as clearSession,
  restoreSession,
  saveUser,
  signOut,
  startSession,
  type User,
} from './auth'
import { journal } from './journal'

/**
 * The app session. The refresh token is read from secure storage asynchronously, so until it has
 * been read the state is `restoring` and the splash screen stays up.
 */

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  /** The session is still being read from storage: too early to show the sign-in screen. */
  restoring: boolean
}

interface AuthContextType {
  auth: AuthState
  login: (user: User, tokens: AuthTokensApiResponse) => Promise<void>
  /** Ends the session: the sign-out button, an environment switch, and every server-side teardown. */
  logout: () => Promise<void>
  updateUser: (updates: Partial<User>) => void
}

const ANONYMOUS: AuthState = { user: null, isAuthenticated: false, restoring: false }

async function loadInitialAuth(): Promise<AuthState> {
  const user = await restoreSession()
  return user ? { user, isAuthenticated: true, restoring: false } : ANONYMOUS
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ user: null, isAuthenticated: false, restoring: true })

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

  const login = useCallback(async (user: User, tokens: AuthTokensApiResponse) => {
    await startSession(user, tokens)
    journal.reset()
    setAuth({ user, isAuthenticated: true, restoring: false })
  }, [])

  /**
   * The only way a session ends: an explicit sign-out, a rejected refresh, an "account deleted or
   * blocked" response, or an environment switch.
   */
  const endSession = useCallback(async () => {
    await clearSession()
    journal.reset()
    setAuth(ANONYMOUS)
  }, [])

  /** The person signs out: the server ends the session first, then the same teardown. */
  const logout = useCallback(async () => {
    await signOut()
    journal.reset()
    setAuth(ANONYMOUS)
  }, [])

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

  return (
    <AuthContext.Provider value={{ auth, login, logout, updateUser }}>{children}</AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
