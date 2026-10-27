import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { selfCheckManager } from '../../../managers/self-check-manager'
import { GetSelfCheckConsentQuery } from '../../../managers/self-check-manager'
import { GetSelfCheckConsentOperation } from './get-self-check-consent.operation'
import {
  GetSelfCheckConsentOperationErrorCode,
  type GetSelfCheckConsentResult,
} from './get-self-check-consent.types'

@requestHandler(GetSelfCheckConsentOperation)
export class GetSelfCheckConsentOperationHandler implements RequestHandler<
  GetSelfCheckConsentOperation,
  GetSelfCheckConsentResult
> {
  async handle(c: GetSelfCheckConsentOperation): Promise<GetSelfCheckConsentResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted)
      return { success: false, error: GetSelfCheckConsentOperationErrorCode.USER_NOT_FOUND }
    const { version } = await selfCheckManager.execute(new GetSelfCheckConsentQuery({ userId: c.userId }))
    return { success: true, version }
  }
}
