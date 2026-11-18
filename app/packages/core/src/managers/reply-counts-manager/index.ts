// 1. Handler imports
import './commands/count-reply/count-reply.handler'
import './queries/get-reply-count/get-reply-count.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CountReplyCommand } from './commands/count-reply/count-reply.command'
export type { CountReplyCommandData } from './commands/count-reply/count-reply.command'
export { GetReplyCountQuery } from './queries/get-reply-count/get-reply-count.query'
export type { GetReplyCountQueryData } from './queries/get-reply-count/get-reply-count.query'

// 3. Type re-exports
export type { CountReplyCommandResult } from './commands/count-reply/count-reply.types'
export { CountReplyCommandErrorCode } from './commands/count-reply/count-reply.types'
export type { GetReplyCountQueryResult, ReplyCountDTO } from './queries/get-reply-count/get-reply-count.types'

// 4. Union type
import type { CountReplyCommand } from './commands/count-reply/count-reply.command'
import type { GetReplyCountQuery } from './queries/get-reply-count/get-reply-count.query'

export type ReplyCountsManagerRequests = CountReplyCommand | GetReplyCountQuery

// 5. Facade
export class ReplyCountsManager implements IReplyCountsManager {
  async execute<T extends ReplyCountsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: ReplyCountsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IReplyCountsManager {
  execute<T extends ReplyCountsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const replyCountsManager: IReplyCountsManager = new ReplyCountsManager()
