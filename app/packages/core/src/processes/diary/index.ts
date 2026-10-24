// 1. Handler imports
import './handlers'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export {
  CreateWeekSummaryOperation,
  CreateYearStoryOperation,
  DeleteDiaryDataOperation,
  DiaryOperationErrorCode,
  GetDiaryEventsOperation,
  GetDiaryOperation,
  GetYearOperation,
  ListWeekSummariesOperation,
  PutMoodCheckinOperation,
  RunWeeklyDigestsOperation,
} from './operations'
export type { DiaryEvent, DiaryView, ReminderState, YearView } from './operations'
export { WEEK_SUMMARY_MIN_DAYS, YEAR_STORY_EXTEND_WEEKS, YEAR_STORY_MIN_WEEKS } from './handlers'
export type { DiarySummaryDTO, MoodCheckinDTO } from '../../managers/diary-manager'

// 4. Union type
import type {
  CreateWeekSummaryOperation,
  CreateYearStoryOperation,
  DeleteDiaryDataOperation,
  GetDiaryEventsOperation,
  GetDiaryOperation,
  GetYearOperation,
  ListWeekSummariesOperation,
  PutMoodCheckinOperation,
  RunWeeklyDigestsOperation,
} from './operations'

export type DiaryOperations =
  | CreateWeekSummaryOperation
  | CreateYearStoryOperation
  | DeleteDiaryDataOperation
  | GetDiaryEventsOperation
  | GetDiaryOperation
  | GetYearOperation
  | ListWeekSummariesOperation
  | PutMoodCheckinOperation
  | RunWeeklyDigestsOperation

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
