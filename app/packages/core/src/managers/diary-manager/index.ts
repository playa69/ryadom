// 1. Handler imports
import './handlers'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export {
  DeleteUserDiaryCommand,
  ListDiarySummariesQuery,
  ListMoodCheckinsQuery,
  UpsertDiarySummaryCommand,
  UpsertMoodCheckinCommand,
} from './requests'
export type { DiarySummaryDTO, MoodCheckinDTO } from './requests'

// 4. Union type
import type {
  DeleteUserDiaryCommand,
  ListDiarySummariesQuery,
  ListMoodCheckinsQuery,
  UpsertDiarySummaryCommand,
  UpsertMoodCheckinCommand,
} from './requests'

export type DiaryManagerRequests =
  | UpsertMoodCheckinCommand
  | ListMoodCheckinsQuery
  | UpsertDiarySummaryCommand
  | ListDiarySummariesQuery
  | DeleteUserDiaryCommand

// 5. Facade
export class DiaryManager implements IDiaryManager {
  async execute<T extends DiaryManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: DiaryManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IDiaryManager {
  execute<T extends DiaryManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const diaryManager: IDiaryManager = new DiaryManager()
