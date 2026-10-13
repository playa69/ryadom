// 1. Handler imports
import './commands/record-memory-consent-event/record-memory-consent-event.handler'
import './queries/get-latest-memory-consent-event/get-latest-memory-consent-event.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { RecordMemoryConsentEventCommand } from './commands/record-memory-consent-event/record-memory-consent-event.command'
export type { RecordMemoryConsentEventCommandData } from './commands/record-memory-consent-event/record-memory-consent-event.command'
export { GetLatestMemoryConsentEventQuery } from './queries/get-latest-memory-consent-event/get-latest-memory-consent-event.query'
export type { GetLatestMemoryConsentEventQueryData } from './queries/get-latest-memory-consent-event/get-latest-memory-consent-event.query'

// 3. Type re-exports
export type { RecordMemoryConsentEventCommandResult } from './commands/record-memory-consent-event/record-memory-consent-event.types'
export type { GetLatestMemoryConsentEventQueryResult } from './queries/get-latest-memory-consent-event/get-latest-memory-consent-event.types'
export type { MemoryConsentEventDTO } from './shared/memory-consent-event.dto'

// 4. Union type
import type { RecordMemoryConsentEventCommand } from './commands/record-memory-consent-event/record-memory-consent-event.command'
import type { GetLatestMemoryConsentEventQuery } from './queries/get-latest-memory-consent-event/get-latest-memory-consent-event.query'

export type MemoryConsentEventsManagerRequests =
  RecordMemoryConsentEventCommand | GetLatestMemoryConsentEventQuery

// 5. Facade
export class MemoryConsentEventsManager implements IMemoryConsentEventsManager {
  async execute<T extends MemoryConsentEventsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: MemoryConsentEventsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IMemoryConsentEventsManager {
  execute<T extends MemoryConsentEventsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const memoryConsentEventsManager: IMemoryConsentEventsManager = new MemoryConsentEventsManager()
