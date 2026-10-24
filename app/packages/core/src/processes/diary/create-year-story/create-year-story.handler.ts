import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { userZone } from '../shared/user-zone'
import { DigestFailureCode, makeYearStory } from '../shared/digests'
import { CreateYearStoryOperation } from './create-year-story.operation'
import { CreateYearStoryOperationErrorCode, type CreateYearStoryResult } from './create-year-story.types'

@requestHandler(CreateYearStoryOperation)
export class CreateYearStoryOperationHandler implements RequestHandler<CreateYearStoryOperation, CreateYearStoryResult> {
  async handle(c: CreateYearStoryOperation): Promise<CreateYearStoryResult> {
    if (!(await userZone(c.userId))) return { success: false, error: CreateYearStoryOperationErrorCode.USER_NOT_FOUND }
    const made = await makeYearStory(c.userId, c.year, c.now ?? new Date())
    if (made.success) return { success: true, summary: made.summary }
    switch (made.error) {
      case DigestFailureCode.NOT_ENOUGH_WEEKS:
        return { success: false, error: CreateYearStoryOperationErrorCode.NOT_ENOUGH_WEEKS }
      case DigestFailureCode.SUMMARY_UNAVAILABLE:
        return { success: false, error: CreateYearStoryOperationErrorCode.SUMMARY_UNAVAILABLE }
      case DigestFailureCode.NOT_ENOUGH_DAYS:
        throw new Error('A year story does not depend on the days of one week')
      default:
        return assertNever(made.error)
    }
  }
}
