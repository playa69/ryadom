export enum RecordUserConsentCommandErrorCode {
  /** The same kind in the same version is already on record: the first acceptance stands. */
  CONSENT_ALREADY_RECORDED = 'CONSENT_ALREADY_RECORDED',
}

export type RecordUserConsentCommandResult =
  { success: true } | { success: false; error: RecordUserConsentCommandErrorCode }
