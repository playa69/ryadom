'use client'

import { useRouter } from 'next/navigation'
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
import { WEB_PENDING_AUTH_KEY } from '@/lib/storage-keys'

/**
 * State shared by the multi-step anonymous screens (register → confirm, forgot → reset).
 *
 * The email survives a reload (a phone often reloads the tab while the person reads the code in the
 * mail app), so it goes to sessionStorage, which dies with the tab. The password never leaves
 * memory: it only spares the person typing it twice, and a reload simply sends them to the sign-in
 * screen. The provider lives in the (auth) layout, which stays mounted across these screens.
 */

export type FlowKind = 'confirm' | 'reset'

interface Pending {
  kind: FlowKind
  email: string
}

export interface AuthFlow {
  /** False until sessionStorage has been read, so a screen does not redirect too early. */
  ready: boolean
  termsUrl: string
  privacyUrl: string
  /** The address of the running flow, or null when that flow was never started in this tab. */
  emailFor(kind: FlowKind): string | null
  begin(kind: FlowKind, email: string, password?: string, consented?: boolean): void
  /** Hands the password over once and forgets it. */
  takePassword(): string | null
  /**
   * Hands over once whether the person agreed to the terms on the registration screen, and forgets
   * it: the account is only signed in after the code, and that is when the agreement is recorded.
   */
  takeConsent(): boolean
  clear(): void
}

const STORAGE_KEY = WEB_PENDING_AUTH_KEY

function readStored(): Pending | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<Pending> | null
    if (
      (value?.kind === 'confirm' || value?.kind === 'reset') &&
      typeof value.email === 'string' &&
      value.email
    ) {
      return { kind: value.kind, email: value.email }
    }
  } catch {
    // Storage blocked or the record is garbage: the flow just starts over.
  }
  return null
}

function writeStored(value: Pending | null): void {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Without storage the flow still works until the tab is reloaded.
  }
}

const FlowContext = createContext<AuthFlow | null>(null)

export function AuthFlowProvider({ webUrl, children }: { webUrl: string; children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [ready, setReady] = useState(false)
  const password = useRef<string | null>(null)
  const consented = useRef(false)

  // sessionStorage does not exist during SSR; reading it here keeps server and client markup equal.
  useEffect(() => {
    setPending(readStored())
    setReady(true)
  }, [])

  const begin = useCallback((kind: FlowKind, email: string, nextPassword?: string, agreed?: boolean) => {
    password.current = nextPassword ?? null
    consented.current = agreed ?? false
    const next = { kind, email }
    writeStored(next)
    setPending(next)
  }, [])

  const takePassword = useCallback(() => {
    const value = password.current
    password.current = null
    return value
  }, [])

  const takeConsent = useCallback(() => {
    const value = consented.current
    consented.current = false
    return value
  }, [])

  const clear = useCallback(() => {
    password.current = null
    consented.current = false
    writeStored(null)
    setPending(null)
  }, [])

  const value = useMemo<AuthFlow>(
    () => ({
      ready,
      termsUrl: `${webUrl}/terms`,
      privacyUrl: `${webUrl}/privacy`,
      emailFor: (kind) => (pending?.kind === kind ? pending.email : null),
      begin,
      takePassword,
      takeConsent,
      clear,
    }),
    [ready, webUrl, pending, begin, takePassword, takeConsent, clear],
  )

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>
}

export function useAuthFlow(): AuthFlow {
  const ctx = useContext(FlowContext)
  if (!ctx) throw new Error('useAuthFlow must be used inside the (auth) layout')
  return ctx
}

/**
 * The address a step screen works with. It stays available after the flow is cleared (the screen
 * is still showing while the session is being started), and a person who arrives without a
 * running flow is sent to `fallbackHref`: opened directly, or the tab came back empty.
 */
export function useFlowEmail(kind: FlowKind, fallbackHref: string): string | null {
  const router = useRouter()
  const flow = useAuthFlow()
  const pending = flow.emailFor(kind)
  const [kept, setKept] = useState<string | null>(null)
  if (pending && pending !== kept) setKept(pending)

  const checked = useRef(false)
  useEffect(() => {
    if (!flow.ready || checked.current) return
    checked.current = true
    if (!pending) router.replace(fallbackHref)
  }, [flow.ready, pending, router, fallbackHref])

  return pending ?? kept
}
