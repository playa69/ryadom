/**
 * Application API paths. Parameters travel in the query string or the body; the only
 * path parameter is the dialog id.
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
  Me = '/api/auth/me',
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

/** `/api/ota/<file>`: the exact file name a client was told to fetch by `/api/app-status`. */
export function otaBundlePath(file: string): string {
  return `${ApiPath.OtaBundle}/${encodeURIComponent(file)}`
}
