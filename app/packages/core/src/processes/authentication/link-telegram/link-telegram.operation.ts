import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { LinkTelegramResult } from './link-telegram.types'

export interface LinkTelegramOperationData {
  userId: string
  /** `Telegram.WebApp.initData` of the Mini App the person is signed in from. */
  initData: string
}

export class LinkTelegramOperation extends RequestData<LinkTelegramResult> {
  /** Survives minification: LinkTelegramOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'LinkTelegramOperation'

  public readonly userId: string

  @hasPII(true)
  public readonly initData: string

  constructor(data: LinkTelegramOperationData) {
    super()
    this.userId = data.userId
    this.initData = data.initData
  }
}
