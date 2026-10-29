export enum ClaimDiarySummaryCommandErrorCode {
  /** Another replica holds the period, or its final text is already there. */
  ALREADY_CLAIMED = 'ALREADY_CLAIMED',
}

export type ClaimDiarySummaryCommandResult =
  { success: true } | { success: false; error: ClaimDiarySummaryCommandErrorCode }
