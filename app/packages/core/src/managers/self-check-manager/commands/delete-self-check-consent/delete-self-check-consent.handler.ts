import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { selfCheckResults, userConsents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toSelfCheckResultDTO } from '../../shared/self-check.dto'
import { DeleteSelfCheckConsentCommand } from './delete-self-check-consent.command'
import { type DeleteSelfCheckConsentCommandResult } from './delete-self-check-consent.types'

@requestHandler(DeleteSelfCheckConsentCommand)
export class DeleteSelfCheckConsentCommandHandler implements RequestHandler<DeleteSelfCheckConsentCommand, DeleteSelfCheckConsentCommandResult> {
  async handle(c: DeleteSelfCheckConsentCommand): Promise<DeleteSelfCheckConsentCommandResult> {
    // The consent of this kind is withdrawn: the rows are removed (the results go with it in the process).
    await getDb()
      .delete(userConsents)
      .where(and(eq(userConsents.userId, c.userId), eq(userConsents.kind, 'self_check')))
    return { success: true }
  }
}
