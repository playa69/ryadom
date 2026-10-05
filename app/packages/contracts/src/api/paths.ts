/**
 * Application API paths. Parameters travel in the query string or the body; the only
 * path parameters are the dialog id and the session id.
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
  /** WebSocket: the stream of a single dialog. */
  DialogsWs = '/api/dialogs/ws',
}

/** `/api/dialogs/:id` and `/api/dialogs/:id/end` are built from the dialog id. */
export function dialogPath(dialogId: string): string {
  return `${ApiPath.Dialogs}/${encodeURIComponent(dialogId)}`
}

export function dialogEndPath(dialogId: string): string {
  return `${dialogPath(dialogId)}/end`
}

/** `/api/auth/sessions/:id`: one session of the person. */
export function sessionPath(sessionId: string): string {
  return `${ApiPath.Sessions}/${encodeURIComponent(sessionId)}`
}

/** `/api/ota/<file>`: the exact file name a client was told to fetch by `/api/app-status`. */
export function otaBundlePath(file: string): string {
  return `${ApiPath.OtaBundle}/${encodeURIComponent(file)}`
}
