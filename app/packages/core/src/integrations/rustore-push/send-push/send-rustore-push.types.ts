export enum SendRuStorePushRequestErrorCode {
  /** `404 NOT_FOUND`: the token is no longer the device's (the app was removed, the token was deleted or replaced). */
  TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND',
  /** The server holds no service token for the device's push project, so nothing was sent. */
  PROJECT_NOT_CONFIGURED = 'PROJECT_NOT_CONFIGURED',
}

export type SendRuStorePushResponse =
  { success: true } | { success: false; error: SendRuStorePushRequestErrorCode }
