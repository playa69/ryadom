import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { selfCheckConsentEvents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RecordSelfCheckConsentEventCommand } from './record-self-check-consent-event.command'
import { type RecordSelfCheckConsentEventCommandResult } from './record-self-check-consent-event.types'

@requestHandler(RecordSelfCheckConsentEventCommand)
export class RecordSelfCheckConsentEventCommandHandler implements RequestHandler<
  RecordSelfCheckConsentEventCommand,
  RecordSelfCheckConsentEventCommandResult
> {
  async handle(c: RecordSelfCheckConsentEventCommand): Promise<RecordSelfCheckConsentEventCommandResult> {
    await getDb()
      .insert(selfCheckConsentEvents)
      .values({ id: c.id, userId: c.userId, action: c.action, version: c.version, at: c.at })
    return { success: true }
  }
}
