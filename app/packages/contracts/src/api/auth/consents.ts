/**
 * `POST /api/auth/me/consents` — the agreements of the first screen: the person is 18 or older, the
 * service is self-help and not therapy, and they accept the terms of use and the processing of
 * personal data in the version they were shown (`POLICY_VERSION`).
 *
 * All three go together: nothing is recorded unless every one is true. A conversation with the
 * agent (`POST /api/dialogs`) is closed until they are on record. Accepting the same version again
 * is a success and leaves the first acceptance as it was.
 *
 * Whether the person has agreed, and to which version, is in `GET /api/auth/me`
 * (`consentsCompleted`, `consentVersion`). 400 when the body is not the shape below, 422 when
 * `offerVersion` is not a date.
 */

export enum AcceptConsentsApiErrorCode {
  /** The person says they are under 18: nothing is recorded and the service is closed to them. */
  AGE_RESTRICTED = 'AGE_RESTRICTED',
  /** The disclaimer or the terms were not accepted. */
  CONSENT_DECLINED = 'CONSENT_DECLINED',
  /** The account is gone. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export interface AcceptConsentsApiRequest {
  ageConfirmed: boolean
  disclaimerAccepted: boolean
  offerAccepted: boolean
  /** The version of the terms on the screen, a date such as `2026-10-04`. */
  offerVersion: string
}

export interface AcceptConsentsApiResponse {
  consentsCompleted: boolean
  /** ISO 8601: when this version was first accepted. */
  acceptedAt: string
}
