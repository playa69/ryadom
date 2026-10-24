import type { DialogShareDTO } from '../../../managers/dialog-shares-manager'
import { shareToken, shareUrl } from './share-token'

/** The owner's view of an active link. `url` carries the token. */
export interface OwnedDialogShareDTO {
  shareId: string
  url: string
  createdAt: Date
  expiresAt: Date
  viewCount: number
  lastViewedAt: Date | null
}

export function toOwnedDialogShareDTO(share: DialogShareDTO): OwnedDialogShareDTO {
  return {
    shareId: share.id,
    url: shareUrl(shareToken(share.id)),
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    viewCount: share.viewCount,
    lastViewedAt: share.lastViewedAt,
  }
}

export interface SharedDialogDTO {
  startedAt: Date
  sharedAt: Date
  expiresAt: Date
  isOpen: boolean
  messages: { role: 'user' | 'assistant'; text: string; createdAt: Date }[]
}
