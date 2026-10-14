import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { VerifyInitDataRequestResult } from './verify-init-data.types'

export interface VerifyInitDataRequestData {
  /** `Telegram.WebApp.initData` as the Mini App received it. */
  initData: string
}

export class VerifyInitDataRequest extends RequestData<VerifyInitDataRequestResult> {
  /** Survives build minification: VerifyInitDataRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'VerifyInitDataRequest'

  /** It names the person and, while fresh, signs them in: never logged. */
  @hasPII(true)
  public readonly initData: string

  constructor(data: VerifyInitDataRequestData) {
    super()
    this.initData = data.initData
  }
}
