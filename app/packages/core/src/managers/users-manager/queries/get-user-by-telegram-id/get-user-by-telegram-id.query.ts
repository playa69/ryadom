import { RequestData } from 'mediatr-ts'
import type { GetUserByTelegramIdQueryResult } from './get-user-by-telegram-id.types'

export interface GetUserByTelegramIdQueryData {
  telegramId: number
}

export class GetUserByTelegramIdQuery extends RequestData<GetUserByTelegramIdQueryResult> {
  /** Survives minification: GetUserByTelegramIdQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetUserByTelegramIdQuery'

  public readonly telegramId: number

  constructor(data: GetUserByTelegramIdQueryData) {
    super()
    this.telegramId = data.telegramId
  }
}
