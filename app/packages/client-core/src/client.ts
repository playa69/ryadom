import type { AppStatusApiResponse } from '@ryadom/contracts/api/app-status'
import type {
  ConfirmEmailApiErrorCode,
  ConfirmEmailApiRequest,
} from '@ryadom/contracts/api/auth/confirm-email'
import type {
  AcceptConsentsApiErrorCode,
  AcceptConsentsApiRequest,
  AcceptConsentsApiResponse,
} from '@ryadom/contracts/api/auth/consents'
import type { DeviceLoginApiRequest, DeviceLoginApiResponse } from '@ryadom/contracts/api/auth/device'
import type { ForgotPasswordApiRequest } from '@ryadom/contracts/api/auth/forgot-password'
import type {
  LinkEmailApiErrorCode,
  LinkEmailApiRequest,
  LinkEmailApiResponse,
} from '@ryadom/contracts/api/auth/link-email'
import type { LoginApiRequest } from '@ryadom/contracts/api/auth/login'
import type { LogoutApiRequest } from '@ryadom/contracts/api/auth/logout'
import type { LogoutAllApiRequest } from '@ryadom/contracts/api/auth/logout-all'
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
  LinkTelegramApiErrorCode,
  LinkTelegramApiRequest,
  LinkTelegramApiResponse,
  TelegramLoginApiErrorCode,
  TelegramLoginApiRequest,
  TelegramLoginApiResponse,
} from '@ryadom/contracts/api/auth/telegram'
import type {
  ResetPasswordApiErrorCode,
  ResetPasswordApiRequest,
} from '@ryadom/contracts/api/auth/reset-password'
import type {
  EndSessionApiErrorCode,
  ListSessionsApiResponse,
  SessionApiResponse,
} from '@ryadom/contracts/api/auth/sessions'
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
import {
  DialogMemoryMode,
  MEMORY_CONSENT_VERSION,
  type CreateMemoryFactApiErrorCode,
  type CreateMemoryFactApiRequest,
  type ForgetMemoryApiErrorCode,
  type MemoryInstructionApiErrorCode,
  type MemoryInstructionApiResponse,
  type MemoryApiResponse,
  type MemoryChangesApiErrorCode,
  type MemoryChangesApiResponse,
  type MemoryExportApiResponse,
  type MemoryFactApiResponse,
  type UpdateMemoryFactApiErrorCode,
  type UpdateMemoryFactApiRequest,
  type UpdateMemorySettingsApiErrorCode,
  type UpdateMemorySettingsApiRequest,
  type UpdateMemorySettingsApiResponse,
} from '@ryadom/contracts/api/memory'
import {
  DialogShareApiErrorCode,
  type CreateDialogShareApiRequest,
  type DialogShareApiResponse,
  type SharedDialogApiResponse,
} from '@ryadom/contracts/api/dialog-shares'
import {
  ApiPath,
  dialogEndPath,
  dialogPath,
  dialogSharePath,
  memoryFactPath,
  sessionPath,
  sharedDialogPath,
} from '@ryadom/contracts/api/paths'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { newDeviceCredentials } from './device'
import { DialogSocket, type DialogMessageView, type DialogSocketHandlers } from './dialog-socket'
import { ApiError, NETWORK_ERROR_STATUS, type ApiOutcome } from './errors'
import { isTokenValid, tokenSubject } from './jwt'
import type { SessionStorage, User } from './storage'
import { createTracing } from './tracing'
import { supportedTtsCodecs } from './voice/tts-decoder'

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
  /** Sent as `x-client-id` so that the logs say which app a request came from. */
  clientId?: string
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
export type DeviceLoginResult = DeviceLoginApiResponse

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
  const tracing = createTracing(config.clientId)

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
        headers: { 'Content-Type': 'application/json', ...tracing(), ...(await versionHeaders()) },
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
      // A retry after a refresh is a request of its own, so it gets its own trace id.
      return fetch(`${config.apiBase()}${path}`, {
        method: opts.method ?? 'GET',
        headers: { ...headers, ...tracing() },
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

  /**
   * Signing out: the server ends the session first, so that a copy of its token dies with it, then
   * this device forgets it. The server is not waited on for long and its silence changes nothing:
   * someone who signs out offline is signed out here all the same.
   */
  async function signOut(): Promise<void> {
    if (!sessionToken) return clearSession()
    // The storage now belongs to someone else (a stale tab): their session is not this tab's to end.
    // Owning it also adopts a newer token than this tab remembers, if another tab refreshed.
    if (!(await ownsStoredSession())) return forgetSession()
    const token = sessionToken
    if (token) {
      const body: LogoutApiRequest = { refreshToken: token }
      await fetch(`${config.apiBase()}${ApiPath.Logout}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tracing(), ...(await versionHeaders()) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3_000),
      }).catch(() => undefined)
    }
    await clearSession()
  }

  return {
    getAccessToken: (): string | null => accessToken,
    refreshSession,
    restoreSession,
    revalidateSession,
    startSession,
    /**
     * Ends the session on this device only: drops the tokens and the stored user. For a session
     * that is already over (the server refused it, the account is gone). A person's own sign-out is
     * `signOut`.
     */
    endSession: clearSession,
    signOut,
    saveUser,

    // ─── account ──────────────────────────────────────────────────────────────

    /** Sign-in. Any failure is ApiError(401): the server does not name the reason. */
    login: (email: string, password: string): Promise<LoginResult> => {
      const body: LoginApiRequest = { email, password }
      return apiFetch<LoginResult>(ApiPath.Login, { method: 'POST', body })
    },

    /**
     * Sign-in without an email. The first call on a device makes an account for it, later ones
     * return that account, whatever happened to the session in between. Like `login` it starts no
     * session: the caller does, with the result. A failure is ApiError(401) for a key the server
     * does not accept, and the stored identity is left alone: only the person can give up an account.
     */
    deviceLogin: async (): Promise<DeviceLoginResult> => {
      // A failed read is not "no identity": making a new one would orphan the account the old one opened.
      let device = await config.storage.getDevice()
      if (!device) {
        device = newDeviceCredentials()
        // Saved before the server hears of it: an account made for an identity we then forgot could
        // never be reached again. If the storage refuses, the account works until the session ends.
        await config.storage.setDevice(device).catch(() => undefined)
      }
      const body: DeviceLoginApiRequest = { deviceId: device.deviceId, deviceKey: device.deviceKey }
      return apiFetch<DeviceLoginResult>(ApiPath.DeviceLogin, { method: 'POST', body })
    },

    /**
     * Whether this device already has an anonymous identity, which is to say an account that
     * `deviceLogin` will return. A first launch has none and shows the first screen; every later one
     * signs in without asking. A storage that cannot be read counts as "none": the first screen is
     * the safe place to land, and `deviceLogin` itself refuses to make a new identity in that case.
     */
    hasDevice: async (): Promise<boolean> => {
      try {
        return (await config.storage.getDevice()) !== null
      } catch {
        return false
      }
    },

    /**
     * Forgets the anonymous identity of this device: when its account is deleted, when the address is
     * confirmed (the account then signs in by email, and the server forgets the device too), and
     * when the person leaves the account for another one.
     */
    forgetDevice: async (): Promise<void> => {
      await config.storage.setDevice(null).catch(() => undefined)
    },

    /**
     * The three agreements of the first screen, recorded for the signed-in account. All three go
     * together, and the version is the one this build shows (`POLICY_VERSION`): the server keeps what
     * the person was shown. Until they are on record the server will not start a conversation.
     */
    acceptConsents: (
      offerVersion: string = POLICY_VERSION,
    ): Promise<ApiOutcome<AcceptConsentsApiResponse, AcceptConsentsApiErrorCode>> => {
      const body: AcceptConsentsApiRequest = {
        ageConfirmed: true,
        disclaimerAccepted: true,
        offerAccepted: true,
        offerVersion,
      }
      return apiOutcome<AcceptConsentsApiResponse, AcceptConsentsApiErrorCode>(ApiPath.Consents, {
        method: 'POST',
        body,
      })
    },

    /**
     * Gives an anonymous account an address and a password. The address counts once the code from
     * the email is entered (`confirmEmail`), after which the account also signs in by email.
     */
    linkEmail: (
      email: string,
      password: string,
    ): Promise<ApiOutcome<LinkEmailApiResponse, LinkEmailApiErrorCode>> => {
      const body: LinkEmailApiRequest = { email, password }
      return apiOutcome<LinkEmailApiResponse, LinkEmailApiErrorCode>(ApiPath.LinkEmail, {
        method: 'POST',
        body,
      })
    },

    /**
     * Sign-in from the Telegram Mini App with its launch data (`Telegram.WebApp.initData`). Without
     * `createAccount` it only finds the account of this Telegram user (`ACCOUNT_NOT_FOUND` when there is
     * none); with it, one is made. Like `login` it starts no session: the caller does, with the result.
     */
    telegramLogin: (
      initData: string,
      createAccount = false,
    ): Promise<ApiOutcome<TelegramLoginApiResponse, TelegramLoginApiErrorCode>> => {
      const body: TelegramLoginApiRequest = { initData, createAccount }
      return apiOutcome<TelegramLoginApiResponse, TelegramLoginApiErrorCode>(ApiPath.TelegramLogin, {
        method: 'POST',
        body,
      })
    },

    /** The signed-in account takes the Telegram user of the Mini App it is open in. */
    linkTelegram: (
      initData: string,
    ): Promise<ApiOutcome<LinkTelegramApiResponse, LinkTelegramApiErrorCode>> => {
      const body: LinkTelegramApiRequest = { initData }
      return apiOutcome<LinkTelegramApiResponse, LinkTelegramApiErrorCode>(ApiPath.LinkTelegram, {
        method: 'POST',
        body,
      })
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

    // ─── sessions ─────────────────────────────────────────────────────────────

    /** The person's open sessions, the most recently used first, this device's marked `current`. */
    listSessions: async (): Promise<SessionApiResponse[]> =>
      (await apiFetch<ListSessionsApiResponse>(ApiPath.Sessions)).sessions,

    /**
     * Ends another device's session. A refusal named `SESSION_NOT_FOUND` means it is gone already
     * (ended elsewhere, or by the time the list was read), which is where the person wanted it.
     * This device's own session is ended by `signOut`.
     */
    revokeSession: async (sessionId: string): Promise<ApiOutcome<void, EndSessionApiErrorCode>> =>
      voidOutcome(
        await apiOutcome<null, EndSessionApiErrorCode>(sessionPath(sessionId), { method: 'DELETE' }),
      ),

    /**
     * "Sign out on all devices". With `keepCurrent` the others end and this one stays; without it
     * this one ends too on the server, and the caller then forgets it locally (`signOut`, which
     * finds the session already gone and still clears the device).
     */
    signOutEverywhere: async (keepCurrent: boolean): Promise<void> => {
      const body: LogoutAllApiRequest = { keepCurrent }
      await apiFetch<null>(ApiPath.LogoutAll, { method: 'POST', body })
    },

    // ─── dialogs ──────────────────────────────────────────────────────────────

    /**
     * A plain start returns the open dialog if there is one (see `nextStartStep`); `startNew` is the
     * person's answer "end it and begin a new one", and is sent only then. `memory` goes out only as
     * `off` (a conversation "without memory"): `on` is the server's default, so a start that asks for
     * nothing special looks exactly as it did before memory existed.
     */
    startDialog: (
      mode: DialogMode,
      options: { startNew?: boolean; memory?: DialogMemoryMode } = {},
    ): Promise<ApiOutcome<StartDialogApiResponse, StartDialogApiErrorCode>> => {
      const body: StartDialogApiRequest = { mode }
      if (options.startNew) body.startNew = true
      if (options.memory === DialogMemoryMode.Off) body.memory = DialogMemoryMode.Off
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

    /** The person's active link to a dialog; null when there is none. */
    getDialogShare: (dialogId: string): Promise<ApiOutcome<DialogShareApiResponse | null, DialogApiErrorCode>> =>
      apiOutcome<DialogShareApiResponse | null, DialogApiErrorCode>(dialogSharePath(dialogId)),

    createDialogShare: (
      dialogId: string,
      data: CreateDialogShareApiRequest,
    ): Promise<ApiOutcome<DialogShareApiResponse, DialogApiErrorCode | DialogShareApiErrorCode>> =>
      apiOutcome<DialogShareApiResponse, DialogApiErrorCode | DialogShareApiErrorCode>(dialogSharePath(dialogId), {
        method: 'POST',
        body: data,
      }),

    revokeDialogShare: async (dialogId: string): Promise<ApiOutcome<void, DialogApiErrorCode>> =>
      voidOutcome(
        await apiOutcome<null, DialogApiErrorCode>(dialogSharePath(dialogId), { method: 'DELETE' }),
      ),

    /**
     * What a link opens, for someone who may not be signed in at all: no Authorization header, no
     * refresh. `gone` is one answer for every reason the link no longer works.
     */
    getSharedDialog: async (token: string): Promise<SharedDialogResult> => {
      let res: Response
      try {
        res = await fetch(`${config.apiBase()}${sharedDialogPath(token)}`, {
          headers: { ...(await versionHeaders()), ...tracing() },
        })
      } catch {
        return { status: 'unavailable' }
      }
      if (res.status === 404) return { status: 'gone' }
      if (!res.ok) return { status: 'unavailable' }
      const envelope = (await res.json().catch(() => null)) as ApiEnvelope<SharedDialogApiResponse> | null
      if (!envelope || !envelope.status) return { status: 'unavailable' }
      return { status: 'ok', dialog: envelope.result }
    },

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
          // The agent's speech in the smallest codec this device decodes (Opus, else μ-law).
          ttsCodecs: () => supportedTtsCodecs(),
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

    // ─── memory ───────────────────────────────────────────────────────────────
    // What comes back holds the person's own words: the screens show it and keep it in memory only,
    // never in logs, analytics or storage.

    /** Everything the agent remembers and the person's switch. Works even while memory is off or unavailable. */
    getMemory: (): Promise<MemoryApiResponse> => apiFetch<MemoryApiResponse>(ApiPath.Memory),

    /**
     * The switch "Запоминать". Turning it on is the person's answer to the consent sheet of this build
     * (`MEMORY_CONSENT_VERSION`), which the server records; turning it off deletes nothing.
     */
    setMemoryEnabled: (
      enabled: boolean,
    ): Promise<ApiOutcome<UpdateMemorySettingsApiResponse, UpdateMemorySettingsApiErrorCode>> => {
      const body: UpdateMemorySettingsApiRequest = enabled
        ? { enabled: true, consentAccepted: true, consentVersion: MEMORY_CONSENT_VERSION }
        : { enabled: false }
      return apiOutcome<UpdateMemorySettingsApiResponse, UpdateMemorySettingsApiErrorCode>(
        ApiPath.MemorySettings,
        {
          method: 'PUT',
          body,
        },
      )
    },

    /** A fact the person writes themselves: it is theirs and pinned. */
    createMemoryFact: (
      fact: CreateMemoryFactApiRequest,
    ): Promise<ApiOutcome<MemoryFactApiResponse, CreateMemoryFactApiErrorCode>> =>
      apiOutcome<MemoryFactApiResponse, CreateMemoryFactApiErrorCode>(ApiPath.MemoryFacts, {
        method: 'POST',
        body: fact,
      }),

    /** One change at a time: a correction, "Запомнить", pin or unpin, or "Верно". */
    updateMemoryFact: (
      factId: string,
      change: UpdateMemoryFactApiRequest,
    ): Promise<ApiOutcome<MemoryFactApiResponse, UpdateMemoryFactApiErrorCode>> =>
      apiOutcome<MemoryFactApiResponse, UpdateMemoryFactApiErrorCode>(memoryFactPath(factId), {
        method: 'PATCH',
        body: change,
      }),

    /** "Забыть" and "Не запоминать". A fact that is gone already counts as forgotten. */
    forgetMemoryFact: async (factId: string): Promise<ApiOutcome<void, ForgetMemoryApiErrorCode>> =>
      voidOutcome(
        await apiOutcome<null, ForgetMemoryApiErrorCode>(memoryFactPath(factId), { method: 'DELETE' }),
      ),

    /** "Забыть всё": the facts go, the conversations and the switch stay. */
    forgetAllMemory: async (): Promise<ApiOutcome<void, ForgetMemoryApiErrorCode>> =>
      voidOutcome(await apiOutcome<null, ForgetMemoryApiErrorCode>(ApiPath.Memory, { method: 'DELETE' })),

    /** What one conversation added to memory, for the card "Я запомнил" (see `pollMemoryChanges`). */
    getMemoryChanges: (
      dialogId: string,
    ): Promise<ApiOutcome<MemoryChangesApiResponse, MemoryChangesApiErrorCode>> =>
      apiOutcome<MemoryChangesApiResponse, MemoryChangesApiErrorCode>(
        `${ApiPath.MemoryChanges}?dialogId=${encodeURIComponent(dialogId)}`,
      ),

    /** "Скажи, что поправить или убрать": a request in the person's words, carried out on the notes. */
    memoryInstruction: (
      text: string,
    ): Promise<ApiOutcome<MemoryInstructionApiResponse, MemoryInstructionApiErrorCode>> =>
      apiOutcome<MemoryInstructionApiResponse, MemoryInstructionApiErrorCode>(ApiPath.MemoryInstruction, {
        method: 'POST',
        body: { text },
      }),

    /** "Скачать мою память": everything, guesses and proposed facts included. */
    exportMemory: (): Promise<MemoryExportApiResponse> =>
      apiFetch<MemoryExportApiResponse>(ApiPath.MemoryExport),
  }
}

/** The answer to opening a link. */
export type SharedDialogResult =
  | { status: 'ok'; dialog: SharedDialogApiResponse }
  | { status: 'gone' }
  | { status: 'unavailable' }

export type RyadomClient = ReturnType<typeof createClient>
