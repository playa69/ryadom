import type { UserConsentDTO } from '../../shared/user-consent.dto'

export interface ListUserConsentsQueryResult {
  success: true
  /** Every acceptance on record, the newest first; empty for a person who has agreed to nothing. */
  consents: UserConsentDTO[]
}
