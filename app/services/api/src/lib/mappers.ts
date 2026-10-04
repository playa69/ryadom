import type { UserDTO } from '@ryadom/core/processes/authentication'
import type { ConsentStatusDTO } from '@ryadom/core/processes/consents'
import type { DialogDTO, DialogListItemDTO, DialogSummaryDTO } from '@ryadom/core/processes/dialogs'
import type { MeApiResponse } from '@ryadom/contracts/api/auth/me'
import type { AuthUserApiResponse } from '@ryadom/contracts/api/auth/shared'
import {
  DialogMode,
  type DialogApiResponse,
  type DialogListItemApiResponse,
  type DialogSummaryApiResponse,
} from '@ryadom/contracts/api/dialogs'

/**
 * Mappers from core DTOs to route responses. Core DTOs never leave the server and
 * fields are listed by name, so a new field in the core does not reach the app on its own.
 */

export function toAuthUser(user: UserDTO): AuthUserApiResponse {
  return { id: user.id, email: user.email, name: user.name }
}

export function toMe(user: UserDTO, consent: ConsentStatusDTO): MeApiResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isEmailConfirmed: user.isEmailConfirmed,
    createdAt: user.createdAt.toISOString(),
    consentsCompleted: consent.completed,
    consentVersion: consent.offerVersion,
  }
}

export function toDialogSummary(summary: DialogSummaryDTO | null): DialogSummaryApiResponse | null {
  if (!summary) return null
  return {
    title: summary.title,
    themes: summary.themes,
    tensionBefore: summary.tensionBefore,
    tensionAfter: summary.tensionAfter,
  }
}

export function toDialogListItem(item: DialogListItemDTO): DialogListItemApiResponse {
  return {
    dialogId: item.dialogId,
    // The agent has no modes yet and the field of the app contract is stable: every conversation is a vent.
    mode: DialogMode.Vent,
    startedAt: item.startedAt.toISOString(),
    endedAt: item.endedAt?.toISOString() ?? null,
    summary: toDialogSummary(item.summary),
  }
}

export function toDialog(dialog: DialogDTO): DialogApiResponse {
  return {
    ...toDialogListItem(dialog),
    messages: dialog.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt.toISOString(),
      // Nothing marks a message as a crisis any more: the screen only ever got the SOS frame for it.
      safetyLevel: null,
    })),
  }
}
