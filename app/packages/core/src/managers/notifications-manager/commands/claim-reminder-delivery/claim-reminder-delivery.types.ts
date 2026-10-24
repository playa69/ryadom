export enum ClaimReminderDeliveryCommandErrorCode {
  ALREADY_CLAIMED = 'ALREADY_CLAIMED',
}

export type ClaimReminderDeliveryCommandResult =
  | { success: true }
  | { success: false; error: ClaimReminderDeliveryCommandErrorCode }
