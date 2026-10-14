import {
  authenticationProcess,
  LinkTelegramOperation,
  LinkTelegramOperationErrorCode,
  TelegramLoginOperation,
  TelegramLoginOperationErrorCode,
} from '@ryadom/core/processes/authentication'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import {
  LinkTelegramApiErrorCode,
  TelegramLoginApiErrorCode,
  type LinkTelegramApiResponse,
  type TelegramLoginApiResponse,
} from '@ryadom/contracts/api/auth/telegram'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { identifyUser } from '../../lib/analytics'
import { apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireAuth } from '../../lib/auth-guard'
import { clientDevice } from '../../lib/client-device'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { toAuthUser } from '../../lib/mappers'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'

/**
 * Sign-in from the Telegram Mini App (`POST /api/auth/telegram`) and linking the Telegram user to the
 * signed-in account (`POST /api/auth/telegram/link`). The launch data is checked in the core; what it
 * says about the person never reaches the logs.
 */
const initData = z.string().min(1).max(8192)
const loginSchema = z.object({ initData, createAccount: z.boolean().optional() })
const linkSchema = z.object({ initData })

export function telegramRoutes(
  app: Hono<AppEnv>,
  { jwt, logger, rateLimiter, sessions, analytics }: RouteDeps,
): void {
  app.post(
    ApiPath.TelegramLogin,
    limitByIp(rateLimiter, 'telegram-login', RATE_LIMITS.telegramLogin.perIp),
    jsonBody(loginSchema),
    async (c) => {
      const body = c.req.valid('json')
      const result = await authenticationProcess.execute(
        new TelegramLoginOperation({ initData: body.initData, createAccount: body.createAccount === true }),
      )
      if (!result.success) {
        logger.info({ reason: result.error }, 'Вход через Telegram отклонён')
        switch (result.error) {
          case TelegramLoginOperationErrorCode.NOT_CONFIGURED:
            return apiRefused(
              c,
              TelegramLoginApiErrorCode.NOT_CONFIGURED,
              'Telegram sign-in is not configured',
            )
          case TelegramLoginOperationErrorCode.INIT_DATA_INVALID:
            return apiRefused(c, TelegramLoginApiErrorCode.INIT_DATA_INVALID, 'Launch data is not valid')
          case TelegramLoginOperationErrorCode.INIT_DATA_EXPIRED:
            return apiRefused(c, TelegramLoginApiErrorCode.INIT_DATA_EXPIRED, 'Launch data is too old')
          case TelegramLoginOperationErrorCode.ACCOUNT_NOT_FOUND:
            return apiRefused(
              c,
              TelegramLoginApiErrorCode.ACCOUNT_NOT_FOUND,
              'No account for this Telegram user',
            )
          case TelegramLoginOperationErrorCode.USER_INACTIVE:
            return apiRefused(c, TelegramLoginApiErrorCode.USER_INACTIVE, 'Account is inactive')
          default:
            return assertNever(result.error)
        }
      }

      const response: TelegramLoginApiResponse = {
        user: toAuthUser(result.user),
        tokens: await sessions.start(result.user.id, clientDevice(c)),
        isNewAccount: result.isNewAccount,
      }
      identifyUser(analytics, result.user)
      if (result.isNewAccount)
        analytics.capture(result.user.id, AnalyticsEvent.AccountCreated, { kind: 'telegram' })
      analytics.capture(result.user.id, AnalyticsEvent.LoggedIn, { method: 'telegram' })
      return apiOk(c, response)
    },
  )

  app.post(
    ApiPath.LinkTelegram,
    requireAuth(jwt),
    limitByIp(rateLimiter, 'link-telegram', RATE_LIMITS.attempt.perIp),
    jsonBody(linkSchema),
    async (c) => {
      const body = c.req.valid('json')
      const { userId } = authUser(c)
      const result = await authenticationProcess.execute(
        new LinkTelegramOperation({ userId, initData: body.initData }),
      )
      if (!result.success) {
        logger.info({ reason: result.error }, 'Привязка Telegram отклонена')
        switch (result.error) {
          case LinkTelegramOperationErrorCode.NOT_CONFIGURED:
            return apiRefused(c, LinkTelegramApiErrorCode.NOT_CONFIGURED, 'Telegram is not configured')
          case LinkTelegramOperationErrorCode.INIT_DATA_INVALID:
            return apiRefused(c, LinkTelegramApiErrorCode.INIT_DATA_INVALID, 'Launch data is not valid')
          case LinkTelegramOperationErrorCode.INIT_DATA_EXPIRED:
            return apiRefused(c, LinkTelegramApiErrorCode.INIT_DATA_EXPIRED, 'Launch data is too old')
          case LinkTelegramOperationErrorCode.TELEGRAM_TAKEN:
            return apiRefused(
              c,
              LinkTelegramApiErrorCode.TELEGRAM_TAKEN,
              'This Telegram user has another account',
            )
          case LinkTelegramOperationErrorCode.ALREADY_LINKED:
            return apiRefused(
              c,
              LinkTelegramApiErrorCode.ALREADY_LINKED,
              'The account has another Telegram user',
            )
          case LinkTelegramOperationErrorCode.USER_NOT_FOUND:
            return apiRefused(c, LinkTelegramApiErrorCode.USER_NOT_FOUND, 'User not found')
          case LinkTelegramOperationErrorCode.USER_INACTIVE:
            return apiRefused(c, LinkTelegramApiErrorCode.USER_INACTIVE, 'Account is inactive')
          default:
            return assertNever(result.error)
        }
      }

      analytics.capture(userId, AnalyticsEvent.TelegramLinked)
      const response: LinkTelegramApiResponse = { telegramLinked: true }
      return apiOk(c, response)
    },
  )
}
