/**
 * `deleted`: the agent no longer has the conversation (the share link is revoked). False when it is still there: the
 * deletion did not happen, and nothing was changed. Only an agent that does not answer is a failure, and it throws.
 */
export type ConfirmDialogDeletedResult = { success: true; deleted: boolean }
