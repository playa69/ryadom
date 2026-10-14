import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { getEnv } from '../../../config'
import { checkInitData } from '../init-data'
import { VerifyInitDataRequest } from './verify-init-data.request'
import { VerifyInitDataRequestErrorCode, type VerifyInitDataRequestResult } from './verify-init-data.types'

/** Checks Mini App launch data against the configured bot (see `checkInitData`). */
@requestHandler(VerifyInitDataRequest)
export class VerifyInitDataRequestHandler implements RequestHandler<
  VerifyInitDataRequest,
  VerifyInitDataRequestResult
> {
  async handle(request: VerifyInitDataRequest): Promise<VerifyInitDataRequestResult> {
    const env = getEnv()
    if (!env.TELEGRAM_BOT_TOKEN)
      return { success: false, error: VerifyInitDataRequestErrorCode.NOT_CONFIGURED }
    const check = checkInitData(request.initData, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_INIT_DATA_MAX_AGE_SEC)
    if (check.ok) return { success: true, telegramUser: check.user }
    return {
      success: false,
      error:
        check.reason === 'expired'
          ? VerifyInitDataRequestErrorCode.EXPIRED
          : VerifyInitDataRequestErrorCode.INVALID,
    }
  }
}
