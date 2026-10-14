import { RequestData } from 'mediatr-ts'
import type { LinkUserTelegramCommandResult } from './link-user-telegram.types'

export interface LinkUserTelegramCommandData {
  userId: string
  telegramId: number
}

export class LinkUserTelegramCommand extends RequestData<LinkUserTelegramCommandResult> {
  /** Survives minification: LinkUserTelegramCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'LinkUserTelegramCommand'

  public readonly userId: string
  public readonly telegramId: number

  constructor(data: LinkUserTelegramCommandData) {
    super()
    this.userId = data.userId
    this.telegramId = data.telegramId
  }
}
