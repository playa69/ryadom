import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { TelegramLoginResult } from './telegram-login.types'

export interface TelegramLoginOperationData {
  /** `Telegram.WebApp.initData` as the Mini App received it. */
  initData: string
  /**
   * Make an account when this Telegram user has none. The app asks for it only from the first screen,
   * after the person has agreed to the terms; the silent sign-in at launch never makes one.
   */
  createAccount: boolean
}

export class TelegramLoginOperation extends RequestData<TelegramLoginResult> {
  /** Survives minification: TelegramLoginOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'TelegramLoginOperation'

  @hasPII(true)
  public readonly initData: string

  public readonly createAccount: boolean

  constructor(data: TelegramLoginOperationData) {
    super()
    this.initData = data.initData
    this.createAccount = data.createAccount
  }
}
