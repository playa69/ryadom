import { nameInputSchema } from '@ryadom/core/config'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  UpdateUserNameCommand,
  UpdateUserNameCommandErrorCode,
  usersManager,
} from '@ryadom/core/managers/users-manager'
import {
  accountDeletionProcess,
  DeleteAccountOperation,
  DeleteAccountOperationErrorCode,
} from '@ryadom/core/processes/account-deletion'
import { consentsProcess, GetConsentStatusOperation } from '@ryadom/core/processes/consents'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { MeApiErrorCode, type MeApiResponse } from '@ryadom/contracts/api/auth/me'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { toMe } from '../../lib/mappers'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/** Profile: GET, PATCH (name), DELETE ("erase everything"). */

const patchBody = z.object({
  name: z.string(),
})

/** The profile in contract shape; null means there is no such user. Shared by GET and PATCH. */
async function readMe(userId: string): Promise<MeApiResponse | null> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return null
      default:
        return assertNever(found.error)
    }
  }
  const { status } = await consentsProcess.execute(new GetConsentStatusOperation({ userId }))
  return toMe(found.user, status)
}

export function meRoutes(app: Hono<AppEnv>, { jwt, logger }: RouteDeps): void {
  app.get(ApiPath.Me, requireAuth(jwt), async (c) => {
    const me = await readMe(authUser(c).userId)
    if (!me) return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
    return apiOk(c, me)
  })

  /** Changing the name is all the profile can change; the email never changes at all. */
  app.patch(ApiPath.Me, requireAuth(jwt), jsonBody(patchBody), async (c) => {
    const name = inputOrNull(nameInputSchema, c.req.valid('json').name)
    if (name === null) return apiError(c, 422, 'Name length is out of range')

    const { userId } = authUser(c)
    const updated = await usersManager.execute(new UpdateUserNameCommand({ userId, name }))
    if (!updated.success) {
      switch (updated.error) {
        case UpdateUserNameCommandErrorCode.USER_NOT_FOUND:
          return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
        default:
          return assertNever(updated.error)
      }
    }

    const me = await readMe(userId)
    if (!me) return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
    return apiOk(c, me)
  })

  /**
   * "Erase everything": the data held by the agent first, then the account. If the agent does not
   * answer, the core throws `AgentUnavailableError`, the error handler replies 503 and the account
   * stays in place, because the promise "we erased everything" was not kept.
   *
   * The session is not revoked separately: the access token lives out its 15 minutes and
   * `/api/auth/refresh` will not renew it, answering `ACCOUNT_DELETED`. The app signs out by itself
   * after a success.
   */
  app.delete(ApiPath.Me, requireAuth(jwt), async (c) => {
    const { userId } = authUser(c)
    const result = await accountDeletionProcess.execute(new DeleteAccountOperation({ userId }))
    if (!result.success) {
      switch (result.error) {
        case DeleteAccountOperationErrorCode.ALREADY_DELETED:
          // A retry after a dropped connection, or two racing requests: the outcome is the one that
          // was asked for, so this counts as success.
          logger.info({ userId }, 'Повторный запрос на удаление уже удалённого аккаунта')
          return apiOk(c, null)
        case DeleteAccountOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
        default:
          return assertNever(result.error)
      }
    }
    logger.info({ userId }, 'Аккаунт удалён по запросу пользователя')
    return apiOk(c, null)
  })
}
