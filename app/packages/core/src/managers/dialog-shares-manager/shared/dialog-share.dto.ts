import type { DialogShareRow } from '@ryadom/db/schema'

export interface DialogShareDTO {
  id: string
  userId: string
  dialogId: string
  upToMessageId: string | null
  createdAt: Date
  expiresAt: Date
  viewCount: number
  lastViewedAt: Date | null
}

export function toDialogShareDTO(row: DialogShareRow): DialogShareDTO {
  return {
    id: row.id,
    userId: row.userId,
    dialogId: row.dialogId,
    upToMessageId: row.upToMessageId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    viewCount: row.viewCount,
    lastViewedAt: row.lastViewedAt,
  }
}
