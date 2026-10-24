import type { DialogShareDTO } from '../../shared/dialog-share.dto'

/** Only an active link: unknown, expired and revoked are one answer. */
export type FindDialogShareByTokenQueryResult = { success: true; share: DialogShareDTO | null }
