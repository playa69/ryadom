import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { randomUUID } from 'node:crypto'
import {
  GetSelfCheckConsentQuery,
  RecordSelfCheckConsentEventCommand,
  selfCheckManager,
} from '../../../managers/self-check-manager'
import { RecordUserConsentCommand, userConsentsManager } from '../../../managers/user-consents-manager'
import { GiveSelfCheckConsentOperation } from './give-self-check-consent.operation'
import {
  GiveSelfCheckConsentOperationErrorCode,
  type GiveSelfCheckConsentResult,
} from './give-self-check-consent.types'

@requestHandler(GiveSelfCheckConsentOperation)
export class GiveSelfCheckConsentOperationHandler implements RequestHandler<
  GiveSelfCheckConsentOperation,
  GiveSelfCheckConsentResult
> {
  async handle(c: GiveSelfCheckConsentOperation): Promise<GiveSelfCheckConsentResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted)
      return { success: false, error: GiveSelfCheckConsentOperationErrorCode.USER_NOT_FOUND }
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
    // The journal: one `granted` when the consent was not in force (a repeat of the same sheet adds nothing).
    const current = await selfCheckManager.execute(new GetSelfCheckConsentQuery({ userId: c.userId }))
    if (current.version === null) {
      await selfCheckManager.execute(
        new RecordSelfCheckConsentEventCommand({
          id: randomUUID(),
          userId: c.userId,
          action: 'granted',
          version: c.version,
          at: new Date(),
        }),
      )
    }
    return { success: true, version: c.version }
  }
}
