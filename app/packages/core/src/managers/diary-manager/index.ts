// 1. Handler imports
import './commands/upsert-mood-checkin/upsert-mood-checkin.handler'
import './commands/upsert-diary-summary/upsert-diary-summary.handler'
import './commands/delete-user-diary/delete-user-diary.handler'
import './queries/get-mood-checkin/get-mood-checkin.handler'
import './queries/list-mood-checkins/list-mood-checkins.handler'
import './queries/list-diary-summaries/list-diary-summaries.handler'
import './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.handler'
import './commands/claim-diary-summary/claim-diary-summary.handler'
import './commands/release-diary-summary/release-diary-summary.handler'
import './commands/delete-diary-summary/delete-diary-summary.handler'
import './commands/mark-diary-summary-for-recompute/mark-diary-summary-for-recompute.handler'
import './queries/list-recompute-markers/list-recompute-markers.handler'
import './commands/create-widget-token/create-widget-token.handler'
import './commands/revoke-widget-tokens/revoke-widget-tokens.handler'
import './queries/find-widget-token/find-widget-token.handler'

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
export { ClaimDiarySummaryCommand } from './commands/claim-diary-summary/claim-diary-summary.command'
export type { ClaimDiarySummaryCommandData } from './commands/claim-diary-summary/claim-diary-summary.command'
export { ReleaseDiarySummaryCommand } from './commands/release-diary-summary/release-diary-summary.command'
export type { ReleaseDiarySummaryCommandData } from './commands/release-diary-summary/release-diary-summary.command'
export { DeleteDiarySummaryCommand } from './commands/delete-diary-summary/delete-diary-summary.command'
export type { DeleteDiarySummaryCommandData } from './commands/delete-diary-summary/delete-diary-summary.command'
export { MarkDiarySummaryForRecomputeCommand } from './commands/mark-diary-summary-for-recompute/mark-diary-summary-for-recompute.command'
export type { MarkDiarySummaryForRecomputeCommandData } from './commands/mark-diary-summary-for-recompute/mark-diary-summary-for-recompute.command'
export { ListRecomputeMarkersQuery } from './queries/list-recompute-markers/list-recompute-markers.query'
export type { ListRecomputeMarkersQueryData } from './queries/list-recompute-markers/list-recompute-markers.query'
export { CreateWidgetTokenCommand } from './commands/create-widget-token/create-widget-token.command'
export type { CreateWidgetTokenCommandData } from './commands/create-widget-token/create-widget-token.command'
export { RevokeWidgetTokensCommand } from './commands/revoke-widget-tokens/revoke-widget-tokens.command'
export type { RevokeWidgetTokensCommandData } from './commands/revoke-widget-tokens/revoke-widget-tokens.command'
export { FindWidgetTokenQuery } from './queries/find-widget-token/find-widget-token.query'
export type { FindWidgetTokenQueryData } from './queries/find-widget-token/find-widget-token.query'

// 3. Type re-exports (enum — значением, остальное — export type)
export type { UpsertMoodCheckinCommandResult } from './commands/upsert-mood-checkin/upsert-mood-checkin.types'
export type { UpsertDiarySummaryCommandResult } from './commands/upsert-diary-summary/upsert-diary-summary.types'
export type { DeleteUserDiaryCommandResult } from './commands/delete-user-diary/delete-user-diary.types'
export type { GetMoodCheckinQueryResult } from './queries/get-mood-checkin/get-mood-checkin.types'
export type { ListMoodCheckinsQueryResult } from './queries/list-mood-checkins/list-mood-checkins.types'
export type { ListDiarySummariesQueryResult } from './queries/list-diary-summaries/list-diary-summaries.types'
export type { ListUsersWithRecentCheckinsQueryResult } from './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.types'
export type { ClaimDiarySummaryCommandResult } from './commands/claim-diary-summary/claim-diary-summary.types'
export { ClaimDiarySummaryCommandErrorCode } from './commands/claim-diary-summary/claim-diary-summary.types'
export type { ReleaseDiarySummaryCommandResult } from './commands/release-diary-summary/release-diary-summary.types'
export type { DeleteDiarySummaryCommandResult } from './commands/delete-diary-summary/delete-diary-summary.types'
export type { MarkDiarySummaryForRecomputeCommandResult } from './commands/mark-diary-summary-for-recompute/mark-diary-summary-for-recompute.types'
export type { ListRecomputeMarkersQueryResult, RecomputeMarkerDTO } from './queries/list-recompute-markers/list-recompute-markers.types'
export type { CreateWidgetTokenCommandResult } from './commands/create-widget-token/create-widget-token.types'
export type { RevokeWidgetTokensCommandResult } from './commands/revoke-widget-tokens/revoke-widget-tokens.types'
export type { FindWidgetTokenQueryResult } from './queries/find-widget-token/find-widget-token.types'
export type { DiarySummaryDTO, MoodCheckinDTO } from './shared/diary.dto'

// 4. Union type
import type { UpsertMoodCheckinCommand } from './commands/upsert-mood-checkin/upsert-mood-checkin.command'
import type { UpsertDiarySummaryCommand } from './commands/upsert-diary-summary/upsert-diary-summary.command'
import type { DeleteUserDiaryCommand } from './commands/delete-user-diary/delete-user-diary.command'
import type { GetMoodCheckinQuery } from './queries/get-mood-checkin/get-mood-checkin.query'
import type { ListMoodCheckinsQuery } from './queries/list-mood-checkins/list-mood-checkins.query'
import type { ListDiarySummariesQuery } from './queries/list-diary-summaries/list-diary-summaries.query'
import type { ListUsersWithRecentCheckinsQuery } from './queries/list-users-with-recent-checkins/list-users-with-recent-checkins.query'
import type { ClaimDiarySummaryCommand } from './commands/claim-diary-summary/claim-diary-summary.command'
import type { ReleaseDiarySummaryCommand } from './commands/release-diary-summary/release-diary-summary.command'
import type { DeleteDiarySummaryCommand } from './commands/delete-diary-summary/delete-diary-summary.command'
import type { MarkDiarySummaryForRecomputeCommand } from './commands/mark-diary-summary-for-recompute/mark-diary-summary-for-recompute.command'
import type { ListRecomputeMarkersQuery } from './queries/list-recompute-markers/list-recompute-markers.query'
import type { CreateWidgetTokenCommand } from './commands/create-widget-token/create-widget-token.command'
import type { RevokeWidgetTokensCommand } from './commands/revoke-widget-tokens/revoke-widget-tokens.command'
import type { FindWidgetTokenQuery } from './queries/find-widget-token/find-widget-token.query'

export type DiaryManagerRequests =
  | UpsertMoodCheckinCommand
  | UpsertDiarySummaryCommand
  | DeleteUserDiaryCommand
  | GetMoodCheckinQuery
  | ListMoodCheckinsQuery
  | ListDiarySummariesQuery
  | ListUsersWithRecentCheckinsQuery
  | ClaimDiarySummaryCommand
  | ReleaseDiarySummaryCommand
  | DeleteDiarySummaryCommand
  | MarkDiarySummaryForRecomputeCommand
  | ListRecomputeMarkersQuery
  | CreateWidgetTokenCommand
  | RevokeWidgetTokensCommand
  | FindWidgetTokenQuery

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
