import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { randomUUID } from 'node:crypto'
import { RecordUserConsentCommand, userConsentsManager } from '../../../managers/user-consents-manager'
import { GiveSelfCheckConsentOperation } from './give-self-check-consent.operation'
import { GiveSelfCheckConsentOperationErrorCode, type GiveSelfCheckConsentResult } from './give-self-check-consent.types'

@requestHandler(GiveSelfCheckConsentOperation)
export class GiveSelfCheckConsentOperationHandler implements RequestHandler<GiveSelfCheckConsentOperation, GiveSelfCheckConsentResult> {
  async handle(c: GiveSelfCheckConsentOperation): Promise<GiveSelfCheckConsentResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted) return { success: false, error: GiveSelfCheckConsentOperationErrorCode.USER_NOT_FOUND }
    // A repeat of the same version leaves the first acceptance as it is (the manager answers CONSENT_ALREADY_RECORDED).
    await userConsentsManager.execute(
      new RecordUserConsentCommand({
        recordId: randomUUID(),
        userId: c.userId,
        kind: 'self_check',
        version: c.version,
        acceptedAt: new Date(),
      }),
    )
    return { success: true, version: c.version }
  }
}
