// 1. Handler imports
import './get-diary/get-diary.handler'
import './put-mood-checkin/put-mood-checkin.handler'
import './list-week-summaries/list-week-summaries.handler'
import './run-weekly-digests/run-weekly-digests.handler'
import './recompute-summaries-after-dialog-deleted/recompute-summaries-after-dialog-deleted.handler'
import './create-widget-token/create-widget-token.handler'
import './revoke-widget-token/revoke-widget-token.handler'
import './resolve-widget-token/resolve-widget-token.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { GetDiaryOperation } from './get-diary/get-diary.operation'
export type { GetDiaryOperationData } from './get-diary/get-diary.operation'
export { PutMoodCheckinOperation } from './put-mood-checkin/put-mood-checkin.operation'
export type { PutMoodCheckinOperationData } from './put-mood-checkin/put-mood-checkin.operation'
export { ListWeekSummariesOperation } from './list-week-summaries/list-week-summaries.operation'
export type { ListWeekSummariesOperationData } from './list-week-summaries/list-week-summaries.operation'
export { RunWeeklyDigestsOperation } from './run-weekly-digests/run-weekly-digests.operation'
export type { RunWeeklyDigestsOperationData } from './run-weekly-digests/run-weekly-digests.operation'
export { RecomputeSummariesAfterDialogDeletedOperation } from './recompute-summaries-after-dialog-deleted/recompute-summaries-after-dialog-deleted.operation'
export type { RecomputeSummariesAfterDialogDeletedOperationData } from './recompute-summaries-after-dialog-deleted/recompute-summaries-after-dialog-deleted.operation'
export { CreateWidgetTokenOperation } from './create-widget-token/create-widget-token.operation'
export type { CreateWidgetTokenOperationData } from './create-widget-token/create-widget-token.operation'
export { RevokeWidgetTokenOperation } from './revoke-widget-token/revoke-widget-token.operation'
export type { RevokeWidgetTokenOperationData } from './revoke-widget-token/revoke-widget-token.operation'
export { ResolveWidgetTokenOperation } from './resolve-widget-token/resolve-widget-token.operation'
export type { ResolveWidgetTokenOperationData } from './resolve-widget-token/resolve-widget-token.operation'

// 3. Type re-exports (enum — значением, остальное — export type)
export type { GetDiaryResult } from './get-diary/get-diary.types'
export { GetDiaryOperationErrorCode } from './get-diary/get-diary.types'
export type { PutMoodCheckinResult } from './put-mood-checkin/put-mood-checkin.types'
export { PutMoodCheckinOperationErrorCode } from './put-mood-checkin/put-mood-checkin.types'
export type { ListWeekSummariesResult } from './list-week-summaries/list-week-summaries.types'
export { ListWeekSummariesOperationErrorCode } from './list-week-summaries/list-week-summaries.types'
export type { RunWeeklyDigestsResult } from './run-weekly-digests/run-weekly-digests.types'
export type { DiaryView } from './get-diary/get-diary.types'
export type { RecomputeSummariesAfterDialogDeletedResult } from './recompute-summaries-after-dialog-deleted/recompute-summaries-after-dialog-deleted.types'
export { RecomputeSummariesAfterDialogDeletedOperationErrorCode } from './recompute-summaries-after-dialog-deleted/recompute-summaries-after-dialog-deleted.types'
export type { CreateWidgetTokenResult } from './create-widget-token/create-widget-token.types'
export { CreateWidgetTokenOperationErrorCode } from './create-widget-token/create-widget-token.types'
export type { RevokeWidgetTokenResult } from './revoke-widget-token/revoke-widget-token.types'
export type { ResolveWidgetTokenResult } from './resolve-widget-token/resolve-widget-token.types'
export type { DiarySummaryDTO, MoodCheckinDTO } from '../../managers/diary-manager'

// 4. Union type
import type { GetDiaryOperation } from './get-diary/get-diary.operation'
import type { PutMoodCheckinOperation } from './put-mood-checkin/put-mood-checkin.operation'
import type { ListWeekSummariesOperation } from './list-week-summaries/list-week-summaries.operation'
import type { RunWeeklyDigestsOperation } from './run-weekly-digests/run-weekly-digests.operation'
import type { RecomputeSummariesAfterDialogDeletedOperation } from './recompute-summaries-after-dialog-deleted/recompute-summaries-after-dialog-deleted.operation'
import type { CreateWidgetTokenOperation } from './create-widget-token/create-widget-token.operation'
import type { RevokeWidgetTokenOperation } from './revoke-widget-token/revoke-widget-token.operation'
import type { ResolveWidgetTokenOperation } from './resolve-widget-token/resolve-widget-token.operation'

export type DiaryOperations =
  | GetDiaryOperation
  | PutMoodCheckinOperation
  | ListWeekSummariesOperation
  | RunWeeklyDigestsOperation
  | RecomputeSummariesAfterDialogDeletedOperation
  | CreateWidgetTokenOperation
  | RevokeWidgetTokenOperation
  | ResolveWidgetTokenOperation

// 5. Facade
export class DiaryProcess implements IDiaryProcess {
  async execute<T extends DiaryOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: DiaryOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IDiaryProcess {
  execute<T extends DiaryOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const diaryProcess: IDiaryProcess = new DiaryProcess()

import {
  RecomputeSummariesAfterDialogDeletedOperation as RecomputeOperation,
  type RecomputeSummariesAfterDialogDeletedOperationData as RecomputeData,
} from './recompute-summaries-after-dialog-deleted/recompute-summaries-after-dialog-deleted.operation'

/**
 * The conversation of `userId` held at `dialogAt` was deleted by hand: its week text goes at once and
 * are written again from what is left. For the delete-dialog route of `services/api` to call after the agent confirmed the
 * deletion; never for retention by age.
 */
export function recomputeSummariesAfterDialogDeleted(data: RecomputeData) {
  return diaryProcess.execute(new RecomputeOperation(data))
}
