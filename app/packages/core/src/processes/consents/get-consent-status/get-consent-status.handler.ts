import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { USER_CONSENT_KINDS } from '@ryadom/db/schema'
import { ListUserConsentsQuery, userConsentsManager } from '../../../managers/user-consents-manager'
import { GetConsentStatusOperation } from './get-consent-status.operation'
import type { GetConsentStatusResult } from './get-consent-status.types'

/**
 * Whether the person has agreed to everything a conversation needs. Which version they agreed to
 * is reported, not judged: whether it is still the current one is the app's call, because only the
 * app knows which version it shows.
 */
@requestHandler(GetConsentStatusOperation)
export class GetConsentStatusOperationHandler implements RequestHandler<
  GetConsentStatusOperation,
  GetConsentStatusResult
> {
  async handle(operation: GetConsentStatusOperation): Promise<GetConsentStatusResult> {
    const { consents } = await userConsentsManager.execute(
      new ListUserConsentsQuery({ userId: operation.userId }),
    )
    const kinds = new Set(consents.map((consent) => consent.kind))
    return {
      success: true,
      status: {
        completed: USER_CONSENT_KINDS.every((kind) => kinds.has(kind)),
        // Newest first, so the first offer found is the latest.
        offerVersion: consents.find((consent) => consent.kind === 'offer')?.version ?? null,
      },
    }
  }
}
