export enum MarkReminderOpenedCommandErrorCode {
  DELIVERY_NOT_FOUND = 'DELIVERY_NOT_FOUND',
}

export type MarkReminderOpenedCommandResult =
  | { success: true }
  | { success: false; error: MarkReminderOpenedCommandErrorCode }
