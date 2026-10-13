import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { memoryConsentEvents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RecordMemoryConsentEventCommand } from './record-memory-consent-event.command'
import type { RecordMemoryConsentEventCommandResult } from './record-memory-consent-event.types'

/**
 * Appends one line to the memory consent journal. Lines are never changed or removed: the journal
 * is the evidence of when consent was in force. A repeat of the same id is a no-op.
 */
@requestHandler(RecordMemoryConsentEventCommand)
export class RecordMemoryConsentEventCommandHandler implements RequestHandler<
  RecordMemoryConsentEventCommand,
  RecordMemoryConsentEventCommandResult
> {
  async handle(command: RecordMemoryConsentEventCommand): Promise<RecordMemoryConsentEventCommandResult> {
    await getDb()
      .insert(memoryConsentEvents)
      .values({
        id: command.eventId,
        userId: command.userId,
        action: command.action,
        version: command.version,
        at: command.at,
      })
      .onConflictDoNothing({ target: memoryConsentEvents.id })
    return { success: true }
  }
}
