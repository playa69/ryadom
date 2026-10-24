// 1. Handler imports
import './commands/upsert-mood-checkin/upsert-mood-checkin.handler'
import './commands/upsert-diary-summary/upsert-diary-summary.handler'
import './commands/delete-user-diary/delete-user-diary.handler'
import './queries/get-mood-checkin/get-mood-checkin.handler'
import './queries/list-mood-checkins/list-mood-checkins.handler'
import './queries/list-diary-summaries/list-diary-summaries.handler'
import './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { UpsertMoodCheckinCommand } from './commands/upsert-mood-checkin/upsert-mood-checkin.command'
export type { UpsertMoodCheckinCommandData } from './commands/upsert-mood-checkin/upsert-mood-checkin.command'
export { UpsertDiarySummaryCommand } from './commands/upsert-diary-summary/upsert-diary-summary.command'
export type { UpsertDiarySummaryCommandData } from './commands/upsert-diary-summary/upsert-diary-summary.command'
export { DeleteUserDiaryCommand } from './commands/delete-user-diary/delete-user-diary.command'
export type { DeleteUserDiaryCommandData } from './commands/delete-user-diary/delete-user-diary.command'
export { GetMoodCheckinQuery } from './queries/get-mood-checkin/get-mood-checkin.query'
export type { GetMoodCheckinQueryData } from './queries/get-mood-checkin/get-mood-checkin.query'
export { ListMoodCheckinsQuery } from './queries/list-mood-checkins/list-mood-checkins.query'
export type { ListMoodCheckinsQueryData } from './queries/list-mood-checkins/list-mood-checkins.query'
export { ListDiarySummariesQuery } from './queries/list-diary-summaries/list-diary-summaries.query'
export type { ListDiarySummariesQueryData } from './queries/list-diary-summaries/list-diary-summaries.query'
export { ListUsersWithRecentCheckinsQuery } from './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.query'
export type { ListUsersWithRecentCheckinsQueryData } from './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.query'

// 3. Type re-exports (enum — значением, остальное — export type)
export type { UpsertMoodCheckinCommandResult } from './commands/upsert-mood-checkin/upsert-mood-checkin.types'
export type { UpsertDiarySummaryCommandResult } from './commands/upsert-diary-summary/upsert-diary-summary.types'
export type { DeleteUserDiaryCommandResult } from './commands/delete-user-diary/delete-user-diary.types'
export type { GetMoodCheckinQueryResult } from './queries/get-mood-checkin/get-mood-checkin.types'
export type { ListMoodCheckinsQueryResult } from './queries/list-mood-checkins/list-mood-checkins.types'
export type { ListDiarySummariesQueryResult } from './queries/list-diary-summaries/list-diary-summaries.types'
export type { ListUsersWithRecentCheckinsQueryResult } from './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.types'
export type { DiarySummaryDTO, MoodCheckinDTO } from './shared/diary.dto'

// 4. Union type
import type { UpsertMoodCheckinCommand } from './commands/upsert-mood-checkin/upsert-mood-checkin.command'
import type { UpsertDiarySummaryCommand } from './commands/upsert-diary-summary/upsert-diary-summary.command'
import type { DeleteUserDiaryCommand } from './commands/delete-user-diary/delete-user-diary.command'
import type { GetMoodCheckinQuery } from './queries/get-mood-checkin/get-mood-checkin.query'
import type { ListMoodCheckinsQuery } from './queries/list-mood-checkins/list-mood-checkins.query'
import type { ListDiarySummariesQuery } from './queries/list-diary-summaries/list-diary-summaries.query'
import type { ListUsersWithRecentCheckinsQuery } from './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.query'

export type DiaryManagerRequests =
  | UpsertMoodCheckinCommand
  | UpsertDiarySummaryCommand
  | DeleteUserDiaryCommand
  | GetMoodCheckinQuery
  | ListMoodCheckinsQuery
  | ListDiarySummariesQuery
  | ListUsersWithRecentCheckinsQuery

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
