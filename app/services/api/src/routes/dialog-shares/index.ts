import {
  CreateDialogShareOperation,
  CreateDialogShareOperationErrorCode,
  dialogSharesProcess,
  GetDialogShareOperation,
  GetDialogShareOperationErrorCode,
  RevokeDialogShareOperation,
  RevokeDialogShareOperationErrorCode,
  ViewSharedDialogOperation,
  type OwnedDialogShareDTO,
  type SharedDialogDTO,
} from '@ryadom/core/processes/dialog-shares'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { DialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import {
  DIALOG_SHARE_TTL_HOURS,
  DialogShareApiErrorCode,
  type DialogShareApiResponse,
  type SharedDialogApiResponse,
} from '@ryadom/contracts/api/dialog-shares'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'

/**
 * Links to one conversation (`REQ-DATA-05`). The owner makes, reads and revokes the link of a dialog
 * (`/api/dialogs/:id/share`); whoever holds it reads the conversation without signing in
 * (`/api/shared/:token`). The token is the secret: it is never logged (see `createApp`), and every
 * answer about it is `no-store`, `no-referrer` and `noindex`.
 */

const createBody = z.object({
  ttlHours: z
    .number()
    .refine((value): value is (typeof DIALOG_SHARE_TTL_HOURS)[number] =>
      (DIALOG_SHARE_TTL_HOURS as readonly number[]).includes(value),
    )
    .optional(),
})

function toShare(share: OwnedDialogShareDTO): DialogShareApiResponse {
  return {
    shareId: share.shareId,
    url: share.url,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt.toISOString(),
    viewCount: share.viewCount,
    lastViewedAt: share.lastViewedAt?.toISOString() ?? null,
  }
}

function toSharedDialog(dialog: SharedDialogDTO): SharedDialogApiResponse {
  return {
    startedAt: dialog.startedAt.toISOString(),
    sharedAt: dialog.sharedAt.toISOString(),
    expiresAt: dialog.expiresAt.toISOString(),
    isOpen: dialog.isOpen,
    messages: dialog.messages.map((m) => ({ role: m.role, text: m.text, createdAt: m.createdAt.toISOString() })),
  }
}

export function dialogSharesRoutes(app: Hono<AppEnv>, { jwt, rateLimiter, sessions }: RouteDeps): void {
  app.post(
    `${ApiPath.Dialogs}/:dialogId/share`,
    requireAuth(jwt),
    requireActiveSession(sessions),
    jsonBody(createBody),
    async (c) => {
      const { userId } = authUser(c)
      if (!(await rateLimiter.hit(`user:dialog-share:${userId}`, RATE_LIMITS.dialogShareCreate.perUser))) {
        return apiError(c, 429, 'Too many links created')
      }
      const result = await dialogSharesProcess.execute(
        new CreateDialogShareOperation({
          userId,
          dialogId: c.req.param('dialogId'),
          ttlHours: c.req.valid('json').ttlHours,
        }),
      )
      if (!result.success) {
        switch (result.error) {
          case CreateDialogShareOperationErrorCode.USER_NOT_FOUND:
            return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
          case CreateDialogShareOperationErrorCode.USER_INACTIVE:
            return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
          case CreateDialogShareOperationErrorCode.DIALOG_NOT_FOUND:
            return apiRefused(c, DialogApiErrorCode.DIALOG_NOT_FOUND, 'Dialog not found')
          case CreateDialogShareOperationErrorCode.ALREADY_EXISTS:
            return apiRefused(c, DialogShareApiErrorCode.SHARE_EXISTS, 'The dialog already has an active link')
          case CreateDialogShareOperationErrorCode.LIMIT_REACHED:
            return apiRefused(c, DialogShareApiErrorCode.SHARE_LIMIT, 'Too many active links')
          case CreateDialogShareOperationErrorCode.DISABLED:
            return apiRefused(c, DialogShareApiErrorCode.SHARE_DISABLED, 'Links are switched off')
          case CreateDialogShareOperationErrorCode.INVALID_TTL:
            return apiError(c, 422, 'ttlHours must be 24, 72 or 168')
          default:
            return assertNever(result.error)
        }
      }
      return apiOk(c, toShare(result.share))
    },
  )

  // The owner's link. Absent is not an error: the screen asks first to decide between "make" and "show".
  app.get(`${ApiPath.Dialogs}/:dialogId/share`, requireAuth(jwt), requireActiveSession(sessions), async (c) => {
    const result = await dialogSharesProcess.execute(
      new GetDialogShareOperation({ userId: authUser(c).userId, dialogId: c.req.param('dialogId') }),
    )
    if (!result.success) {
      switch (result.error) {
        case GetDialogShareOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case GetDialogShareOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        case GetDialogShareOperationErrorCode.SHARE_NOT_FOUND:
          return apiOk(c, null)
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, toShare(result.share))
  })

  app.delete(`${ApiPath.Dialogs}/:dialogId/share`, requireAuth(jwt), requireActiveSession(sessions), async (c) => {
    const result = await dialogSharesProcess.execute(
      new RevokeDialogShareOperation({ userId: authUser(c).userId, dialogId: c.req.param('dialogId') }),
    )
    if (!result.success) {
      switch (result.error) {
        case RevokeDialogShareOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case RevokeDialogShareOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, null)
  })

  // Open: no session. Per address, so that a scan for tokens meets the limit before it meets luck.
  app.get(
    `${ApiPath.Shared}/:token`,
    async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      c.header('X-Robots-Tag', 'noindex, nofollow')
      await next()
    },
    limitByIp(rateLimiter, 'shared-view', RATE_LIMITS.sharedView.perIp),
    async (c) => {
      const result = await dialogSharesProcess.execute(new ViewSharedDialogOperation({ token: c.req.param('token') }))
      // One answer for every reason: the link is gone. The body is the same too.
      if (!result.success) return apiError(c, 404, 'This link is no longer valid')
      return apiOk(c, toSharedDialog(result.dialog))
    },
  )
}
