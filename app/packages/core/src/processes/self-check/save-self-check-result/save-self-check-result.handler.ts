import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { GetUserByIdQuery, usersManager } from '../../../managers/users-manager'
import { selfCheckManager } from '../../../managers/self-check-manager'
import { band as bandOf, score as scoreOf } from '@ryadom/self-check/score'
import { byId } from '@ryadom/self-check/catalog'
import { randomUUID } from 'node:crypto'
import {
  GetSelfCheckConsentQuery,
  GetSelfCheckResultQuery,
  InsertSelfCheckResultCommand,
} from '../../../managers/self-check-manager'
import { SaveSelfCheckResultOperation } from './save-self-check-result.operation'
import {
  SaveSelfCheckResultOperationErrorCode,
  type SaveSelfCheckResultResult,
} from './save-self-check-result.types'

@requestHandler(SaveSelfCheckResultOperation)
export class SaveSelfCheckResultOperationHandler implements RequestHandler<
  SaveSelfCheckResultOperation,
  SaveSelfCheckResultResult
> {
  async handle(c: SaveSelfCheckResultOperation): Promise<SaveSelfCheckResultResult> {
    const found = await usersManager.execute(new GetUserByIdQuery({ userId: c.userId }))
    if (!found.success || found.user.isDeleted)
      return { success: false, error: SaveSelfCheckResultOperationErrorCode.USER_NOT_FOUND }
    const consent = await selfCheckManager.execute(new GetSelfCheckConsentQuery({ userId: c.userId }))
    if (consent.version === null)
      return { success: false, error: SaveSelfCheckResultOperationErrorCode.CONSENT_REQUIRED }

    const test = byId(c.testId)
    if (!test) return { success: false, error: SaveSelfCheckResultOperationErrorCode.UNKNOWN_TEST }
    if (test.version !== c.testVersion)
      return { success: false, error: SaveSelfCheckResultOperationErrorCode.UNKNOWN_VERSION }

    // The server's own count of the answers: a score sent by a client, if any, would be ignored (and none is read).
    let result
    try {
      result = scoreOf(test, c.answers)
    } catch {
      return { success: false, error: SaveSelfCheckResultOperationErrorCode.INVALID_ANSWERS }
    }
    const level = bandOf(test, result.score)
    const now = c.now ?? new Date()
    // A time from the client may be a little in the past (offline) but not in the future.
    const takenAt = c.takenAt && c.takenAt.getTime() <= now.getTime() + 5 * 60_000 ? c.takenAt : now
    const id = randomUUID()
    await selfCheckManager.execute(
      new InsertSelfCheckResultCommand({
        id,
        userId: c.userId,
        testId: test.id,
        testVersion: test.version,
        score: result.score,
        subscores: result.subscales.length > 0 ? result.subscales : null,
        band: level?.label ?? '',
        takenAt,
      }),
    )
    const { result: saved } = await selfCheckManager.execute(
      new GetSelfCheckResultQuery({ userId: c.userId, resultId: id }),
    )
    if (!saved) throw new Error('A result that was just saved is not there')
    return { success: true, result: saved }
  }
}
