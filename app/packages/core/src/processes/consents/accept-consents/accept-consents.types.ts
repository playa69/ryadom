export enum AcceptConsentsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The person says they are under 18: nothing is recorded and the service is closed to them. */
  AGE_RESTRICTED = 'AGE_RESTRICTED',
  /** The disclaimer or the terms were not accepted: all three are needed together. */
  CONSENT_DECLINED = 'CONSENT_DECLINED',
}

export type AcceptConsentsResult =
  | {
      success: true
      /** When the terms of this version were first accepted: a repeat does not move it. */
      acceptedAt: Date
    }
  | { success: false; error: AcceptConsentsOperationErrorCode }
