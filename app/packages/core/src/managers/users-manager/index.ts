// 1. Handler imports
import './commands/create-user/create-user.handler'
import './commands/mark-user-email-confirmed/mark-user-email-confirmed.handler'
import './commands/change-user-email/change-user-email.handler'
import './commands/update-user-name/update-user-name.handler'
import './commands/update-user-voice/update-user-voice.handler'
import './commands/set-user-active/set-user-active.handler'
import './commands/set-user-analytics-opt-out/set-user-analytics-opt-out.handler'
import './commands/set-user-traffic-type/set-user-traffic-type.handler'
import './commands/set-user-deletion-archive/set-user-deletion-archive.handler'
import './commands/soft-delete-user/soft-delete-user.handler'
import './commands/touch-user-activity/touch-user-activity.handler'
import './queries/list-inactive-anonymous-users/list-inactive-anonymous-users.handler'
import './queries/get-user-by-id/get-user-by-id.handler'
import './queries/get-user-by-email/get-user-by-email.handler'
import './queries/search-users/search-users.handler'
import './queries/get-user-deletion-archive/get-user-deletion-archive.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CreateUserCommand } from './commands/create-user/create-user.command'
export type { CreateUserCommandData } from './commands/create-user/create-user.command'
export { MarkUserEmailConfirmedCommand } from './commands/mark-user-email-confirmed/mark-user-email-confirmed.command'
export type { MarkUserEmailConfirmedCommandData } from './commands/mark-user-email-confirmed/mark-user-email-confirmed.command'
export { ChangeUserEmailCommand } from './commands/change-user-email/change-user-email.command'
export type { ChangeUserEmailCommandData } from './commands/change-user-email/change-user-email.command'
export { UpdateUserNameCommand } from './commands/update-user-name/update-user-name.command'
export type { UpdateUserNameCommandData } from './commands/update-user-name/update-user-name.command'
export { UpdateUserVoiceCommand } from './commands/update-user-voice/update-user-voice.command'
export type { UpdateUserVoiceCommandData } from './commands/update-user-voice/update-user-voice.command'
export { SetUserActiveCommand } from './commands/set-user-active/set-user-active.command'
export type { SetUserActiveCommandData } from './commands/set-user-active/set-user-active.command'
export { SetUserAnalyticsOptOutCommand } from './commands/set-user-analytics-opt-out/set-user-analytics-opt-out.command'
export type { SetUserAnalyticsOptOutCommandData } from './commands/set-user-analytics-opt-out/set-user-analytics-opt-out.command'
export { SetUserTrafficTypeCommand } from './commands/set-user-traffic-type/set-user-traffic-type.command'
export type { SetUserTrafficTypeCommandData } from './commands/set-user-traffic-type/set-user-traffic-type.command'
export { SetUserDeletionArchiveCommand } from './commands/set-user-deletion-archive/set-user-deletion-archive.command'
export type { SetUserDeletionArchiveCommandData } from './commands/set-user-deletion-archive/set-user-deletion-archive.command'
export { SoftDeleteUserCommand } from './commands/soft-delete-user/soft-delete-user.command'
export type { SoftDeleteUserCommandData } from './commands/soft-delete-user/soft-delete-user.command'
export { TouchUserActivityCommand } from './commands/touch-user-activity/touch-user-activity.command'
export type { TouchUserActivityCommandData } from './commands/touch-user-activity/touch-user-activity.command'
export { ListInactiveAnonymousUsersQuery } from './queries/list-inactive-anonymous-users/list-inactive-anonymous-users.query'
export type { ListInactiveAnonymousUsersQueryData } from './queries/list-inactive-anonymous-users/list-inactive-anonymous-users.query'
export { GetUserByIdQuery } from './queries/get-user-by-id/get-user-by-id.query'
export type { GetUserByIdQueryData } from './queries/get-user-by-id/get-user-by-id.query'
export { GetUserByEmailQuery } from './queries/get-user-by-email/get-user-by-email.query'
export type { GetUserByEmailQueryData } from './queries/get-user-by-email/get-user-by-email.query'
export { SearchUsersQuery } from './queries/search-users/search-users.query'
export type { SearchUsersQueryData } from './queries/search-users/search-users.query'
export { GetUserDeletionArchiveQuery } from './queries/get-user-deletion-archive/get-user-deletion-archive.query'
export type { GetUserDeletionArchiveQueryData } from './queries/get-user-deletion-archive/get-user-deletion-archive.query'

// 3. Type re-exports
export type { CreateUserCommandResult } from './commands/create-user/create-user.types'
export { CreateUserCommandErrorCode } from './commands/create-user/create-user.types'
export type { MarkUserEmailConfirmedCommandResult } from './commands/mark-user-email-confirmed/mark-user-email-confirmed.types'
export { MarkUserEmailConfirmedCommandErrorCode } from './commands/mark-user-email-confirmed/mark-user-email-confirmed.types'
export type { ChangeUserEmailCommandResult } from './commands/change-user-email/change-user-email.types'
export { ChangeUserEmailCommandErrorCode } from './commands/change-user-email/change-user-email.types'
export type { UpdateUserNameCommandResult } from './commands/update-user-name/update-user-name.types'
export { UpdateUserNameCommandErrorCode } from './commands/update-user-name/update-user-name.types'
export type { UpdateUserVoiceCommandResult } from './commands/update-user-voice/update-user-voice.types'
export { UpdateUserVoiceCommandErrorCode } from './commands/update-user-voice/update-user-voice.types'
export type { SetUserActiveCommandResult } from './commands/set-user-active/set-user-active.types'
export { SetUserActiveCommandErrorCode } from './commands/set-user-active/set-user-active.types'
export type { SetUserAnalyticsOptOutCommandResult } from './commands/set-user-analytics-opt-out/set-user-analytics-opt-out.types'
export { SetUserAnalyticsOptOutCommandErrorCode } from './commands/set-user-analytics-opt-out/set-user-analytics-opt-out.types'
export type { SetUserTrafficTypeCommandResult } from './commands/set-user-traffic-type/set-user-traffic-type.types'
export { SetUserTrafficTypeCommandErrorCode } from './commands/set-user-traffic-type/set-user-traffic-type.types'
export type { SetUserDeletionArchiveCommandResult } from './commands/set-user-deletion-archive/set-user-deletion-archive.types'
export { SetUserDeletionArchiveCommandErrorCode } from './commands/set-user-deletion-archive/set-user-deletion-archive.types'
export type { SoftDeleteUserCommandResult } from './commands/soft-delete-user/soft-delete-user.types'
export { SoftDeleteUserCommandErrorCode } from './commands/soft-delete-user/soft-delete-user.types'
export type { TouchUserActivityCommandResult } from './commands/touch-user-activity/touch-user-activity.types'
export type { ListInactiveAnonymousUsersQueryResult } from './queries/list-inactive-anonymous-users/list-inactive-anonymous-users.types'
export type { GetUserByIdQueryResult } from './queries/get-user-by-id/get-user-by-id.types'
export { GetUserByIdQueryErrorCode } from './queries/get-user-by-id/get-user-by-id.types'
export type { GetUserByEmailQueryResult } from './queries/get-user-by-email/get-user-by-email.types'
export { GetUserByEmailQueryErrorCode } from './queries/get-user-by-email/get-user-by-email.types'
export type { SearchUsersQueryResult } from './queries/search-users/search-users.types'
export type { GetUserDeletionArchiveQueryResult } from './queries/get-user-deletion-archive/get-user-deletion-archive.types'
export { GetUserDeletionArchiveQueryErrorCode } from './queries/get-user-deletion-archive/get-user-deletion-archive.types'
export type { UserDTO, UserSearchSortBy, SortOrder, TrafficType } from './shared/user.dto'
export { ANALYTICS_PREFS_KEY, DELETION_ARCHIVE_KEY, TRAFFIC_TYPE_KEY } from './shared/user.dto'

// 4. Union type
import type { CreateUserCommand } from './commands/create-user/create-user.command'
import type { MarkUserEmailConfirmedCommand } from './commands/mark-user-email-confirmed/mark-user-email-confirmed.command'
import type { ChangeUserEmailCommand } from './commands/change-user-email/change-user-email.command'
import type { UpdateUserNameCommand } from './commands/update-user-name/update-user-name.command'
import type { UpdateUserVoiceCommand } from './commands/update-user-voice/update-user-voice.command'
import type { SetUserActiveCommand } from './commands/set-user-active/set-user-active.command'
import type { SetUserAnalyticsOptOutCommand } from './commands/set-user-analytics-opt-out/set-user-analytics-opt-out.command'
import type { SetUserTrafficTypeCommand } from './commands/set-user-traffic-type/set-user-traffic-type.command'
import type { SetUserDeletionArchiveCommand } from './commands/set-user-deletion-archive/set-user-deletion-archive.command'
import type { SoftDeleteUserCommand } from './commands/soft-delete-user/soft-delete-user.command'
import type { TouchUserActivityCommand } from './commands/touch-user-activity/touch-user-activity.command'
import type { ListInactiveAnonymousUsersQuery } from './queries/list-inactive-anonymous-users/list-inactive-anonymous-users.query'
import type { GetUserByIdQuery } from './queries/get-user-by-id/get-user-by-id.query'
import type { GetUserByEmailQuery } from './queries/get-user-by-email/get-user-by-email.query'
import type { SearchUsersQuery } from './queries/search-users/search-users.query'
import type { GetUserDeletionArchiveQuery } from './queries/get-user-deletion-archive/get-user-deletion-archive.query'

export type UsersManagerRequests =
  | CreateUserCommand
  | MarkUserEmailConfirmedCommand
  | ChangeUserEmailCommand
  | UpdateUserNameCommand
  | UpdateUserVoiceCommand
  | SetUserActiveCommand
  | SetUserAnalyticsOptOutCommand
  | SetUserTrafficTypeCommand
  | SetUserDeletionArchiveCommand
  | SoftDeleteUserCommand
  | TouchUserActivityCommand
  | ListInactiveAnonymousUsersQuery
  | GetUserByIdQuery
  | GetUserByEmailQuery
  | SearchUsersQuery
  | GetUserDeletionArchiveQuery

// 5. Facade
export class UsersManager implements IUsersManager {
  async execute<T extends UsersManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: UsersManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IUsersManager {
  execute<T extends UsersManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const usersManager: IUsersManager = new UsersManager()
