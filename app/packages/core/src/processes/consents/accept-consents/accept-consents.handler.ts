import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { USER_CONSENT_KINDS } from '@ryadom/db/schema'
import { createLogger, inTransaction, validateInput } from '../../../shared'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'
import {
  ListUserConsentsQuery,
  RecordUserConsentCommand,
  RecordUserConsentCommandErrorCode,
  userConsentsManager,
} from '../../../managers/user-consents-manager'
import { AcceptConsentsOperation } from './accept-consents.operation'
import { AcceptConsentsOperationErrorCode, type AcceptConsentsResult } from './accept-consents.types'
import { acceptConsentsSchema } from './accept-consents.validator'

/**
 * The three agreements of the first screen (18+, "this is not therapy", the terms and the processing
 * of personal data), recorded together under one version of the terms. Nothing is recorded unless
 * the person agreed to all of them: a half-accepted screen is an unanswered one.
 *
 * Saying "under 18" is its own refusal, so that the screen can tell the person the service is not
 * for them instead of asking again.
 */
@requestHandler(AcceptConsentsOperation)
export class AcceptConsentsOperationHandler implements RequestHandler<
  AcceptConsentsOperation,
  AcceptConsentsResult
> {
  async handle(operation: AcceptConsentsOperation): Promise<AcceptConsentsResult> {
    const logger = createLogger('consents')
    const input = validateInput(acceptConsentsSchema, { offerVersion: operation.offerVersion })

    const found = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!found.success) {
      switch (found.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: AcceptConsentsOperationErrorCode.USER_NOT_FOUND }
        default:
          return assertNever(found.error)
      }
    }
    if (found.user.isDeleted) {
      return { success: false, error: AcceptConsentsOperationErrorCode.USER_NOT_FOUND }
    }

    if (!operation.ageConfirmed) {
      logger.info('Consents refused: the person is under 18', { userId: operation.userId })
      return { success: false, error: AcceptConsentsOperationErrorCode.AGE_RESTRICTED }
    }
    if (!operation.disclaimerAccepted || !operation.offerAccepted) {
      return { success: false, error: AcceptConsentsOperationErrorCode.CONSENT_DECLINED }
    }

    const userId = operation.userId
    const acceptedAt = new Date()
    await inTransaction(async () => {
      for (const kind of USER_CONSENT_KINDS) {
        const recorded = await userConsentsManager.execute(
          new RecordUserConsentCommand({
            recordId: randomUUID(),
            userId,
            kind,
            version: input.offerVersion,
            acceptedAt,
          }),
        )
        if (!recorded.success) {
          switch (recorded.error) {
            // A repeat (a double tap, a retry after a lost answer): the first acceptance stands.
            case RecordUserConsentCommandErrorCode.CONSENT_ALREADY_RECORDED:
              break
            default:
              assertNever(recorded.error)
          }
        }
      }
    })

    // The answer carries the date on record, which for a repeat is the first acceptance's.
    const { consents } = await userConsentsManager.execute(new ListUserConsentsQuery({ userId }))
    const offer = consents.find(
      (consent) => consent.kind === 'offer' && consent.version === input.offerVersion,
    )
    logger.info('Consents accepted', { userId, version: input.offerVersion })
    return { success: true, acceptedAt: offer?.acceptedAt ?? acceptedAt }
  }
}
