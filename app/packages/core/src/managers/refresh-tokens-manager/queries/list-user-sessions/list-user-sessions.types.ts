import type { SessionDTO } from '../../shared/refresh-token.dto'

export interface ListUserSessionsQueryResult {
  success: true
  /** The most recently used first. */
  sessions: SessionDTO[]
}
