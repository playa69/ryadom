/**
 * Application API paths. Parameters travel in the query string or the body; the only
 * path parameters are the dialog id, the session id and the memory fact id.
 */
export enum ApiPath {
  Health = '/api/health',
  AppStatus = '/api/app-status',
  /** Prefix only: the file name carries the version (`ryadom-<flavor>-<version>.zip`). */
  OtaBundle = '/api/ota',

  Register = '/api/auth/register',
  ConfirmEmail = '/api/auth/confirm-email',
  ResendConfirmation = '/api/auth/resend-confirmation',
  Login = '/api/auth/login',
  DeviceLogin = '/api/auth/device',
  LinkEmail = '/api/auth/email/link',
  /** Sign-in from the Telegram Mini App by its launch data. */
  TelegramLogin = '/api/auth/telegram',
  /** The signed-in account takes the Telegram user of the Mini App it is open in. */
  LinkTelegram = '/api/auth/telegram/link',
  Refresh = '/api/auth/refresh',
  Logout = '/api/auth/logout',
  LogoutAll = '/api/auth/logout-all',
  Sessions = '/api/auth/sessions',
  Me = '/api/auth/me',
  Consents = '/api/auth/me/consents',
  Password = '/api/auth/password',
  ForgotPassword = '/api/auth/forgot-password',
  ResetPassword = '/api/auth/reset-password',

  Dialogs = '/api/dialogs',
  /** Conversations with their recaps (`GET`), for the journal. */
  DialogRecaps = '/api/recaps',
  /** "Write the recap automatically" (`GET`, `PUT`). */
  DialogSettings = '/api/dialog-settings',
  /** WebSocket: the stream of a single dialog. */
  DialogsWs = '/api/dialogs/ws',

  /** Open, no sign-in: `/api/shared/:token` is the conversation behind a link (`REQ-DATA-05`). */
  Shared = '/api/shared',

  /** What the agent remembers about the person (`GET`) and "forget everything" (`DELETE`). */
  Memory = '/api/memory',
  /** The person's switch "Remember" and the consent to it. */
  MemorySettings = '/api/memory/settings',
  /** `/api/memory/facts/:id` corrects or forgets one note; the name is from before notes and stays for the clients that predate them. */
  MemoryFacts = '/api/memory/facts',
  /** What one conversation added to memory: `?dialogId=`. */
  MemoryChanges = '/api/memory/changes',
  /** "Download my memory". */
  MemoryExport = '/api/memory/export',
  /** "Tell Ryadom what to correct or remove": a request in words, carried out on the notes. */
  MemoryInstruction = '/api/memory/notes/instruction',

  /** Results of the tests inside the app (`add-self-check-tests`). */
  SelfCheckResults = '/api/self-check/results',
  SelfCheckLatest = '/api/self-check/latest',
  SelfCheckConsent = '/api/self-check/consent',
  /** A crisis answer was given: counted without a person (no sign-in, no body but the test id). */
  SelfCheckCrisis = '/api/self-check/crisis',

  /** The mood diary (`REQ-WELL-01`): the rest are under it. */
  Diary = '/api/diary',
  DiaryCheckinToday = '/api/diary/checkins/today',
  DiarySummaries = '/api/diary/summaries',
  DiaryWeekSummary = '/api/diary/summaries/week',
  /** Creates (`POST`) and revokes (`DELETE`) the token of the Android widget. */
  DiaryWidgetToken = '/api/diary/widget-token',
  /** Widget token only (`Authorization: Widget <token>`). */
  DiaryWidgetToday = '/api/diary/widget/today',
  DiaryWidgetCheckin = '/api/diary/widget/checkin',

  /** Open: which analytics features are on and the (public) PostHog project token. */
  AnalyticsConfig = '/api/analytics/config',
  /**
   * Prefix only: our reverse proxy to PostHog. The SDK is configured with this as its `api_host`
   * and appends its own paths (`/e`, `/flags`, `/static/...`).
   */
  Ingest = '/api/ingest',
}

/** `/api/dialogs/:id` and `/api/dialogs/:id/end` are built from the dialog id. */
/** One saved result of a test: `DELETE`. */
export function selfCheckResultPath(resultId: string): string {
  return `${ApiPath.SelfCheckResults}/${encodeURIComponent(resultId)}`
}

export function dialogPath(dialogId: string): string {
  return `${ApiPath.Dialogs}/${encodeURIComponent(dialogId)}`
}

/** `/api/dialogs/:id/share`: the person's link to one dialog. */
export function dialogSharePath(dialogId: string): string {
  return `${dialogPath(dialogId)}/share`
}

/** `/api/shared/:token`: what a link opens. */
export function sharedDialogPath(token: string): string {
  return `${ApiPath.Shared}/${encodeURIComponent(token)}`
}

export function dialogEndPath(dialogId: string): string {
  return `${dialogPath(dialogId)}/end`
}

/** `/api/dialogs/:id/recap`: the recap of an ended conversation (`PUT`); `…/recap/draft` is the «Pre-fill» draft (`POST`). */
export function dialogRecapPath(dialogId: string): string {
  return `${dialogPath(dialogId)}/recap`
}

/** `/api/memory/facts/:id`: one remembered note of the person. */
export function memoryFactPath(factId: string): string {
  return `${ApiPath.MemoryFacts}/${encodeURIComponent(factId)}`
}

/** `/api/auth/sessions/:id`: one session of the person. */
export function sessionPath(sessionId: string): string {
  return `${ApiPath.Sessions}/${encodeURIComponent(sessionId)}`
}

/** `/api/ota/<file>`: the exact file name a client was told to fetch by `/api/app-status`. */
export function otaBundlePath(file: string): string {
  return `${ApiPath.OtaBundle}/${encodeURIComponent(file)}`
}

