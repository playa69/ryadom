import type { DialogShareDTO } from '../../shared/dialog-share.dto'

export type GetActiveDialogShareQueryResult = { success: true; share: DialogShareDTO | null }
