import { client } from './platform-adapter'

/**
 * The API surface the screens import. The implementation is @ryadom/client-core, bound to this
 * app's storage and endpoints in platform-adapter.ts; convention: new endpoints are added to
 * client-core (shared with the web app), and only re-exported here.
 */

export { ApiError, NETWORK_ERROR_STATUS, apiErrorText, codeText } from '@ryadom/client-core/index'
export { ACCOUNT_UNAVAILABLE_EVENT, setSessionEndHandler } from './platform-adapter'

export const {
  login,
  deviceLogin,
  telegramLogin,
  linkTelegram,
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
  getDialogShare,
  createDialogShare,
  revokeDialogShare,
  deleteDialog,
  putDialogRecap,
  draftDialogRecap,
  getDialogSettings,
  putDialogSettings,
  getMemory,
  getMemoryChanges,
  setMemoryEnabled,
  updateMemorySettings,
  memoryInstruction,
  updateMemoryFact,
  forgetMemoryFact,
  forgetAllMemory,
  exportMemory,
  createWeekSummary,
  getDiary,
  putMoodCheckin,
  getSelfCheckConsent,
  reportSelfCheckCrisis,
  giveSelfCheckConsent,
  revokeSelfCheckConsent,
  saveSelfCheckResult,
  latestSelfCheckResults,
  listSelfCheckResults,
  deleteSelfCheckResult,
  deleteSelfCheckResults,
} = client
