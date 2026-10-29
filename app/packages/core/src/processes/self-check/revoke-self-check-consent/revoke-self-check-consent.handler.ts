import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { selfCheckManager } from '../../../managers/self-check-manager'
import { randomUUID } from 'node:crypto'
import {
  CountSelfCheckResultsQuery,
  GetSelfCheckConsentQuery,
  RecordSelfCheckConsentEventCommand,
  DeleteSelfCheckResultsCommand,
} from '../../../managers/self-check-manager'
import { inTransaction } from '../../../shared'
import { RevokeSelfCheckConsentOperation } from './revoke-self-check-consent.operation'
import {
  RevokeSelfCheckConsentOperationErrorCode,
  type RevokeSelfCheckConsentResult,
} from './revoke-self-check-consent.types'

@requestHandler(RevokeSelfCheckConsentOperation)
export class RevokeSelfCheckConsentOperationHandler implements RequestHandler<
  RevokeSelfCheckConsentOperation,
  RevokeSelfCheckConsentResult
> {
  async handle(c: RevokeSelfCheckConsentOperation): Promise<RevokeSelfCheckConsentResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted)
      return { success: false, error: RevokeSelfCheckConsentOperationErrorCode.USER_NOT_FOUND }
    // Withdrawing the consent removes every saved result with it, together: no results without a consent.
    const deleted = await inTransaction(async () => {
      const { count } = await selfCheckManager.execute(new CountSelfCheckResultsQuery({ userId: c.userId }))
      await selfCheckManager.execute(new DeleteSelfCheckResultsCommand({ userId: c.userId }))
      // The consent stays on record (`user_consents`); the journal says it was withdrawn and when.
      const current = await selfCheckManager.execute(new GetSelfCheckConsentQuery({ userId: c.userId }))
      if (current.version !== null) {
        await selfCheckManager.execute(
          new RecordSelfCheckConsentEventCommand({
            id: randomUUID(),
            userId: c.userId,
            action: 'revoked',
            version: current.version,
            at: new Date(),
          }),
        )
      }
      return count
    })
    return { success: true, deleted }
  }
}
