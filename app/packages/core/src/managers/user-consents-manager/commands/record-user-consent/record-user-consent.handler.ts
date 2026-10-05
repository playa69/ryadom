import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { userConsents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RecordUserConsentCommand } from './record-user-consent.command'
import {
  RecordUserConsentCommandErrorCode,
  type RecordUserConsentCommandResult,
} from './record-user-consent.types'

/**
 * Writes down one agreement. Accepting again must not move the date of the first acceptance, so a
 * repeat is refused rather than overwritten.
 */
@requestHandler(RecordUserConsentCommand)
export class RecordUserConsentCommandHandler implements RequestHandler<
  RecordUserConsentCommand,
  RecordUserConsentCommandResult
> {
  async handle(command: RecordUserConsentCommand): Promise<RecordUserConsentCommandResult> {
    const [row] = await getDb()
      .insert(userConsents)
      .values({
        id: command.recordId,
        userId: command.userId,
        kind: command.kind,
        version: command.version,
        acceptedAt: command.acceptedAt,
      })
      .onConflictDoNothing({ target: [userConsents.userId, userConsents.kind, userConsents.version] })
      .returning({ id: userConsents.id })
    if (!row) return { success: false, error: RecordUserConsentCommandErrorCode.CONSENT_ALREADY_RECORDED }
    return { success: true }
  }
}
