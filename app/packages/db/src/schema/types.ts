import { customType } from 'drizzle-orm/pg-core'

/** Case-insensitive text (the citext extension): addresses compare regardless of case. */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext'
  },
})

/**
 * Purpose of an emailed code (`email_codes.purpose`). One mechanism for every code: six digits,
 * ten minutes, five attempts.
 *
 * - `confirm_email`: confirming the address after registration;
 * - `reset_password`: setting a new password from the forgot-password flow;
 * - `admin_sign_in`: admin sign-in against the `ADMIN_EMAILS` list.
 *
 * These values are stored in the column, so they must not be changed.
 */
export const EMAIL_CODE_PURPOSES = ['confirm_email', 'reset_password', 'admin_sign_in'] as const
export type EmailCodePurpose = (typeof EMAIL_CODE_PURPOSES)[number]

/** Admin actions written to `audit_log.action`. */
export const AUDIT_LOG_ACTIONS = [
  'USER_BLOCKED',
  'USER_UNBLOCKED',
  'USER_EMAIL_CONFIRMED',
  'USER_ACCOUNT_DELETED',
] as const
export type AuditLogAction = (typeof AUDIT_LOG_ACTIONS)[number]

/**
 * Why a refresh token was retired (`refresh_tokens.revoked_reason`).
 *
 * - `rotated`: it was used and replaced by a successor. Only such a token is forgiven for a few
 *   seconds when presented again (a lost response, two tabs), and only such a token presented late
 *   gives away a stolen copy;
 * - `signed_out`: the person signed out;
 * - `revoked`: ended from outside the session: password change or reset, blocking, deletion.
 *
 * These values are stored in the column, so they must not be changed.
 */
export const REFRESH_TOKEN_REVOKE_REASONS = ['rotated', 'signed_out', 'revoked'] as const
export type RefreshTokenRevokeReason = (typeof REFRESH_TOKEN_REVOKE_REASONS)[number]

/**
 * What a person agreed to (`user_consents.kind`). All three are given on one screen, and a chat
 * with the agent is closed until each has been recorded.
 *
 * - `age_confirmed`: the person is 18 or older;
 * - `disclaimer`: the service is self-help, not therapy or medical care;
 * - `offer`: the terms of use and the processing of personal data, in the version that was shown.
 *
 * These values are stored in the column, so they must not be changed.
 */
export const USER_CONSENT_KINDS = ['age_confirmed', 'disclaimer', 'offer'] as const
export type UserConsentKind = (typeof USER_CONSENT_KINDS)[number]
