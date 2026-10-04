import type { AppStatusApiResponse } from '@ryadom/contracts/api/app-status'
import type {
  ConfirmEmailApiErrorCode,
  ConfirmEmailApiRequest,
} from '@ryadom/contracts/api/auth/confirm-email'
import type { ForgotPasswordApiRequest } from '@ryadom/contracts/api/auth/forgot-password'
import type { LoginApiRequest } from '@ryadom/contracts/api/auth/login'
import type { MeApiResponse, UpdateMeApiRequest } from '@ryadom/contracts/api/auth/me'
import type {
  ChangePasswordApiErrorCode,
  ChangePasswordApiRequest,
} from '@ryadom/contracts/api/auth/password'
import {
  RefreshApiErrorCode,
  type RefreshApiRequest,
  type RefreshApiResponse,
} from '@ryadom/contracts/api/auth/refresh'
import type {
  RegisterApiErrorCode,
  RegisterApiRequest,
  RegisterApiResponse,
} from '@ryadom/contracts/api/auth/register'
import type { ResendConfirmationApiRequest } from '@ryadom/contracts/api/auth/resend-confirmation'
import type {
  ResetPasswordApiErrorCode,
  ResetPasswordApiRequest,
} from '@ryadom/contracts/api/auth/reset-password'
import type { AuthTokensApiResponse, LoginApiResponse } from '@ryadom/contracts/api/auth/shared'
import type {
  DialogApiErrorCode,
  DialogApiResponse,
  DialogMode,
  EndDialogApiRequest,
  EndDialogApiResponse,
  ListDialogsApiResponse,
  StartDialogApiErrorCode,
  StartDialogApiRequest,
  StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import type { ApiEnvelope } from '@ryadom/contracts/api/envelope'
import { AppHeader } from '@ryadom/contracts/api/headers'
import { ApiPath, dialogEndPath, dialogPath } from '@ryadom/contracts/api/paths'
import { DialogSocket, type DialogMessageView, type DialogSocketHandlers } from './dialog-socket'
import { ApiError, NETWORK_ERROR_STATUS, type ApiOutcome } from './errors'
import { isTokenValid, tokenSubject } from './jwt'
import type { SessionStorage, User } from './storage'

/**
 * The API client, one instance per app. Everything the two apps do differently is passed in
 * through `ClientConfig`; everything else — the envelope, the single shared refresh on a 401, the
 * session rules — is the same code for the phone and the browser.
 */

export interface ClientConfig {
  /** No trailing slash. An empty string means the same origin. Read on every call, so it may change. */
  apiBase(): string
  /** `ws(s)://host`, no trailing slash. */
  wsBase(): string
  storage: SessionStorage
  /**
   * Extra headers on every request. A store build puts `X-Platform` and its versions here so the
   * version gate can refuse an outdated one; a browser client returns nothing.
   */
  versionHeaders?(): Promise<Record<string, string>>
  /** The server answered 426: this client is outdated. The session is kept. */
  onUpgradeRequired?(): void
  /** The refresh was refused because the account is deleted or blocked. */
  onAccountUnavailable?(code: RefreshApiErrorCode): void
  /** The session is over (refresh refused, or another tab replaced it). The app resets its own state. */
  onSessionEnd?(): void
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
}

export type LoginResult = LoginApiResponse

export function createClient(config: ClientConfig) {
  let accessToken: string | null = null
  /**
   * The refresh token this client started with, kept in memory so the identity of a tab does not
   * depend on what a later write to the shared storage (another tab) says. Null means no session.
   */
  let sessionToken: string | null = null
  /** Whether `sessionToken` is in the storage; after a failed write the session lives in memory only. */
  let persisted = false
  /** Bumped whenever a session starts or ends, so a refresh already in flight cannot outlive its session. */
  let epoch = 0
  let refreshing: Promise<boolean> | null = null

  const versionHeaders = async (): Promise<Record<string, string>> => (await config.versionHeaders?.()) ?? {}

  // ─── session ────────────────────────────────────────────────────────────────

  /** Drops the session on this client only, leaving the shared storage to whoever owns it now. */
  function forgetSession(): void {
    epoch += 1
    accessToken = null
    sessionToken = null
    persisted = false
    refreshing = null
  }

  async function clearSession(): Promise<void> {
    forgetSession()
    try {
      await config.storage.removeRefreshToken()
    } catch {
      // Nothing to remove, or the storage is unavailable; either way the session is gone.
    }
    await config.storage.setUser(null).catch(() => undefined)
  }

  async function persistRefreshToken(token: string): Promise<boolean> {
    try {
      await config.storage.setRefreshToken(token)
      return true
    } catch {
      // The storage refuses writes (blocked, full, a private mode): the session lasts until the
      // tab or app is closed, which beats not being able to sign in at all.
      return false
    }
  }

  async function readStoredToken(): Promise<string | null> {
    try {
      return await config.storage.getRefreshToken()
    } catch {
      // The record is corrupted or the storage key is lost: signing in again is simpler than
      // working out what exactly broke.
      await clearSession()
      return null
    }
  }

  /**
   * Whether the shared storage still holds this client's session. Another tab may have signed out
   * or in as someone else, and carrying on with the token found there would show that person's
   * data under this tab's identity. The same person signed in again is fine: their token is as good.
   */
  async function ownsStoredSession(): Promise<boolean> {
    if (!sessionToken) return false
    if (!persisted) return true
    let stored: string | null
    try {
      stored = await config.storage.getRefreshToken()
    } catch {
      return true
    }
    if (!stored) return false
    if (stored === sessionToken) return true
    const subject = tokenSubject(stored)
    if (subject === null || subject !== tokenSubject(sessionToken)) return false
    sessionToken = stored
    return true
  }

  /** The user and tokens after a sign-in: the refresh token is stored, the access token is kept in memory. */
  async function startSession(user: User, tokens: AuthTokensApiResponse): Promise<void> {
    epoch += 1
    refreshing = null
    accessToken = tokens.accessToken
    sessionToken = tokens.refreshToken
    persisted = await persistRefreshToken(tokens.refreshToken)
    await config.storage.setUser(user).catch(() => undefined)
  }

  /**
   * While the refresh token is alive the session counts as active: the access token lives only in
   * memory, and the first request gets a 401 and refreshes it.
   */
  async function restoreSession(): Promise<User | null> {
    try {
      const [refreshToken, user] = await Promise.all([readStoredToken(), config.storage.getUser()])
      // A user record of someone other than the token's owner is what a stale tab leaves behind.
      const subject = refreshToken ? tokenSubject(refreshToken) : null
      const consistent = subject === null || !user || user.id === subject
      if (refreshToken && user && consistent && isTokenValid(refreshToken)) {
        sessionToken = refreshToken
        persisted = true
        return user
      }
      if (refreshToken || user) await clearSession()
      return null
    } catch {
      return null
    }
  }

  /**
   * For a storage that other tabs share: call it when the storage may have changed (a `storage`
   * event). If it no longer holds this client's session, the client ends it, leaving the storage
   * alone, since it belongs to whoever wrote there last.
   */
  async function revalidateSession(): Promise<void> {
    if (!sessionToken) return
    const startedAt = epoch
    if (await ownsStoredSession()) return
    if (epoch !== startedAt) return
    forgetSession()
    config.onSessionEnd?.()
  }

  async function saveUser(user: User | null): Promise<void> {
    // A stale tab must not write its user over the record of whoever signed in since.
    if (user && !(await ownsStoredSession())) return
    await config.storage.setUser(user).catch(() => undefined)
  }

  async function tryRefresh(): Promise<boolean> {
    const startedAt = epoch
    if (!(await ownsStoredSession())) {
      if (epoch === startedAt && sessionToken) {
        forgetSession()
        config.onSessionEnd?.()
      }
      return false
    }
    const refreshToken = sessionToken
    if (!refreshToken) return false

    /** A response that arrives after sign-out (or another sign-in) must not bring the session back. */
    const stale = (): boolean => epoch !== startedAt

    /** The server refused the refresh token: the session is over, and so is its stored copy if that is ours. */
    async function refused(): Promise<false> {
      if (stale()) return false
      if (await ownsStoredSession()) await clearSession()
      else forgetSession()
      config.onSessionEnd?.()
      return false
    }

    try {
      const body: RefreshApiRequest = { refreshToken }
      const res = await fetch(`${config.apiBase()}${ApiPath.Refresh}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await versionHeaders()) },
        body: JSON.stringify(body),
      })
      if (stale()) return false
      // The version gate refused: the session is fine, the client is merely outdated. Leave the
      // tokens alone so there is no need to sign in again after the update.
      if (res.status === 426) {
        config.onUpgradeRequired?.()
        return false
      }
      if (!res.ok) {
        // A server failure is no reason to sign out; try again next time.
        if (res.status >= 500) return false
        return await refused()
      }

      const envelope = (await res.json().catch(() => null)) as ApiEnvelope<RefreshApiResponse> | null
      if (stale()) return false
      if (envelope?.status) {
        accessToken = envelope.result.accessToken
        if (envelope.result.refreshToken !== refreshToken) {
          sessionToken = envelope.result.refreshToken
          persisted = await persistRefreshToken(envelope.result.refreshToken)
        }
        return true
      }

      const code = envelope?.errorCode
      if (code === RefreshApiErrorCode.ACCOUNT_DELETED || code === RefreshApiErrorCode.ACCOUNT_INACTIVE) {
        config.onAccountUnavailable?.(code)
      }
      return await refused()
    } catch {
      return false
    }
  }

  /** One refresh for everyone: parallel requests that got a 401 all await the same call. */
  function refreshSession(): Promise<boolean> {
    if (refreshing) return refreshing
    const started: Promise<boolean> = tryRefresh().finally(() => {
      if (refreshing === started) refreshing = null
    })
    refreshing = started
    return started
  }

  // ─── HTTP ───────────────────────────────────────────────────────────────────

  async function send(path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(await versionHeaders()),
    }
    const attempt = (): Promise<Response> => {
      if (accessToken) headers[AppHeader.Authorization] = `Bearer ${accessToken}`
      return fetch(`${config.apiBase()}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
    }

    try {
      let res = await attempt()
      // The access token expired or does not exist yet (cold start: it lives in memory only), so
      // refresh once. If that fails, tryRefresh has already ended the session and the caller sees
      // the 401.
      if (res.status === 401 && sessionToken) {
        if (await refreshSession()) res = await attempt()
      }
      return res
    } catch {
      throw new ApiError(NETWORK_ERROR_STATUS)
    }
  }

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    const res = await send(path, opts)
    if (!res.ok) {
      if (res.status === 426) config.onUpgradeRequired?.()
      throw new ApiError(res.status)
    }
    const envelope = (await res.json().catch(() => null)) as ApiEnvelope<T> | null
    // A 200 that is not an envelope: the server answers something other than the contract.
    if (!envelope || typeof envelope.status !== 'boolean') throw new ApiError(res.status)
    return envelope
  }

  /** A call with no rule codes: success or ApiError. */
  async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const envelope = await request<T>(path, opts)
    if (envelope.status) return envelope.result
    // The route named a rule the caller does not expect: a contract mismatch.
    throw new ApiError(200, envelope.errorCode)
  }

  /** A call with rule codes: a refusal named by a code is an outcome, everything else throws. */
  async function apiOutcome<T, C extends string>(
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiOutcome<T, C>> {
    const envelope = await request<T>(path, opts)
    if (envelope.status) return { ok: true, data: envelope.result }
    return { ok: false, code: envelope.errorCode as C }
  }

  const voidOutcome = <C extends string>(outcome: ApiOutcome<null, C>): ApiOutcome<void, C> =>
    outcome.ok ? { ok: true, data: undefined } : outcome

  const getDialog = (dialogId: string): Promise<ApiOutcome<DialogApiResponse, DialogApiErrorCode>> =>
    apiOutcome<DialogApiResponse, DialogApiErrorCode>(dialogPath(dialogId))

  return {
    getAccessToken: (): string | null => accessToken,
    refreshSession,
    restoreSession,
    revalidateSession,
    startSession,
    /** Ends the session on this device: drops the tokens and the stored user. */
    endSession: clearSession,
    saveUser,

    // ─── account ──────────────────────────────────────────────────────────────

    /** Sign-in. Any failure is ApiError(401): the server does not name the reason. */
    login: (email: string, password: string): Promise<LoginResult> => {
      const body: LoginApiRequest = { email, password }
      return apiFetch<LoginResult>(ApiPath.Login, { method: 'POST', body })
    },

    /** Registration. Returns no session: first the code from the email, then sign-in. */
    register: (
      email: string,
      password: string,
      name: string,
    ): Promise<ApiOutcome<RegisterApiResponse, RegisterApiErrorCode>> => {
      const body: RegisterApiRequest = { email, password, name }
      return apiOutcome<RegisterApiResponse, RegisterApiErrorCode>(ApiPath.Register, { method: 'POST', body })
    },

    confirmEmail: async (
      email: string,
      code: string,
    ): Promise<ApiOutcome<void, ConfirmEmailApiErrorCode>> => {
      const body: ConfirmEmailApiRequest = { email, code }
      return voidOutcome(
        await apiOutcome<null, ConfirmEmailApiErrorCode>(ApiPath.ConfirmEmail, { method: 'POST', body }),
      )
    },

    resendConfirmation: async (email: string): Promise<void> => {
      const body: ResendConfirmationApiRequest = { email }
      await apiFetch<null>(ApiPath.ResendConfirmation, { method: 'POST', body })
    },

    /** Code for a password change. The server answers the same whether the account exists or not. */
    requestPasswordReset: async (email: string): Promise<void> => {
      const body: ForgotPasswordApiRequest = { email }
      await apiFetch<null>(ApiPath.ForgotPassword, { method: 'POST', body })
    },

    resetPassword: async (
      email: string,
      code: string,
      newPassword: string,
    ): Promise<ApiOutcome<void, ResetPasswordApiErrorCode>> => {
      const body: ResetPasswordApiRequest = { email, code, newPassword }
      return voidOutcome(
        await apiOutcome<null, ResetPasswordApiErrorCode>(ApiPath.ResetPassword, { method: 'POST', body }),
      )
    },

    getCurrentUser: (): Promise<MeApiResponse> => apiFetch<MeApiResponse>(ApiPath.Me),

    updateProfile: (data: UpdateMeApiRequest): Promise<MeApiResponse> =>
      apiFetch<MeApiResponse>(ApiPath.Me, { method: 'PATCH', body: data }),

    /**
     * "Erase everything": irreversible and effective immediately. When the agent is unavailable the
     * server answers 503 and the account stays, because the promise was not kept.
     */
    deleteAccount: async (): Promise<void> => {
      await apiFetch<null>(ApiPath.Me, { method: 'DELETE' })
    },

    changePassword: async (
      currentPassword: string,
      newPassword: string,
    ): Promise<ApiOutcome<void, ChangePasswordApiErrorCode>> => {
      const body: ChangePasswordApiRequest = { currentPassword, newPassword }
      return voidOutcome(
        await apiOutcome<null, ChangePasswordApiErrorCode>(ApiPath.Password, { method: 'POST', body }),
      )
    },

    // ─── dialogs ──────────────────────────────────────────────────────────────

    startDialog: (mode: DialogMode): Promise<ApiOutcome<StartDialogApiResponse, StartDialogApiErrorCode>> => {
      const body: StartDialogApiRequest = { mode }
      return apiOutcome<StartDialogApiResponse, StartDialogApiErrorCode>(ApiPath.Dialogs, {
        method: 'POST',
        body,
      })
    },

    listDialogs: (before?: string): Promise<ListDialogsApiResponse> => {
      const query = before ? `?before=${encodeURIComponent(before)}` : ''
      return apiFetch<ListDialogsApiResponse>(`${ApiPath.Dialogs}${query}`)
    },

    getDialog,

    endDialog: (
      dialogId: string,
      data: EndDialogApiRequest,
    ): Promise<ApiOutcome<EndDialogApiResponse, DialogApiErrorCode>> =>
      apiOutcome<EndDialogApiResponse, DialogApiErrorCode>(dialogEndPath(dialogId), {
        method: 'POST',
        body: data,
      }),

    /** A live dialog connection bound to this client's session and address. */
    createDialogSocket: (
      dialogId: string,
      handlers: DialogSocketHandlers,
      greeting?: string | null,
    ): DialogSocket =>
      new DialogSocket(
        {
          getAccessToken: () => accessToken,
          refreshSession,
          wsBase: () => config.wsBase(),
          // The fallback after a drop, for an agent that cannot replay what the person missed.
          loadHistory: async (): Promise<DialogMessageView[] | null> => {
            const result = await getDialog(dialogId).catch(() => null)
            if (!result?.ok) return null
            return result.data.messages.map(({ id, role, text }) => ({ id, role, text }))
          },
        },
        dialogId,
        handlers,
        greeting,
      ),

    getAppStatus: (query: string): Promise<AppStatusApiResponse> =>
      apiFetch<AppStatusApiResponse>(`${ApiPath.AppStatus}?${query}`),
  }
}

export type RyadomClient = ReturnType<typeof createClient>
