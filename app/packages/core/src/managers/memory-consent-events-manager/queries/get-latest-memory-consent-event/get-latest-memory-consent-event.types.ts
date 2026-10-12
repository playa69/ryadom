import type { MemoryConsentEventDTO } from '../../shared/memory-consent-event.dto'

export interface GetLatestMemoryConsentEventQueryResult {
  success: true
  /** The last time the person turned memory on or off; null if they never did. */
  event: MemoryConsentEventDTO | null
}
