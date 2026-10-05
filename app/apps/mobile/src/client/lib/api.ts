import { client } from './platform-adapter'

/**
 * The API surface the screens import. The implementation is @ryadom/client-core, bound to this
 * app's storage and endpoints in platform-adapter.ts; convention: new endpoints are added to
 * client-core (shared with the web app), and only re-exported here.
 */

export {
  AGENT_ERROR_TEXT,
  ApiError,
  NETWORK_ERROR_STATUS,
  NETWORK_ERROR_TEXT,
  SERVER_ERROR_TEXT,
  apiErrorText,
  codeText,
  type ApiErrorTexts,
  type ApiOutcome,
  type LoginResult,
} from '@ryadom/client-core/index'
export { ACCOUNT_UNAVAILABLE_EVENT, setSessionEndHandler } from './platform-adapter'

export const {
  login,
  deviceLogin,
  hasDevice,
  forgetDevice,
  acceptConsents,
  linkEmail,
  register,
  confirmEmail,
  resendConfirmation,
  requestPasswordReset,
  resetPassword,
  getCurrentUser,
  updateProfile,
  deleteAccount,
  changePassword,
  listSessions,
  revokeSession,
  signOutEverywhere,
  startDialog,
  listDialogs,
  getDialog,
  endDialog,
  getAppStatus,
  refreshSession,
} = client
