import type { AgentDialogMemoryMode } from '../../../integrations/agent-api'

export enum StartDialogOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
  /** The person has not agreed to the terms yet (18+, the disclaimer, the offer): the app shows its first screen. */
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
}

export interface StartedDialog {
  dialogId: string
  /** true means an already open dialog was returned: a person has at most one at a time. */
  resumed: boolean
  greeting: string | null
  sinceLastDialogHours: number | null
  /** Messages in the returned dialog: 0 for a new or an empty one. */
  messageCount: number
  /** When the returned dialog last moved (its last message or its end), ISO; null when unknown. */
  lastActivityAt: string | null
  /** The memory mode of the returned dialog: `off` is a conversation "without memory". */
  memoryMode: AgentDialogMemoryMode
  /** Whether the person has memory turned on: the app offers "without memory" only then. */
  memoryEnabled: boolean
}

export type StartDialogResult =
  | { success: true; dialog: StartedDialog }
  | { success: false; error: StartDialogOperationErrorCode }
