import {
  dialogsProcess,
  EndDialogOperation,
  EndDialogOperationErrorCode,
  GetDialogOperation,
  GetDialogOperationErrorCode,
  ListDialogsOperation,
  ListDialogsOperationErrorCode,
  StartDialogOperation,
  StartDialogOperationErrorCode,
} from '@ryadom/core/processes/dialogs'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import {
  DialogApiErrorCode,
  DialogMode,
  StartDialogApiErrorCode,
  type EndDialogApiResponse,
  type ListDialogsApiResponse,
  type StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { toDialog, toDialogListItem, toDialogSummary } from '../../lib/mappers'
import { RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody, queryParams } from '../../lib/request'

/**
 * Dialog REST. The conversation itself runs over WebSocket (`server/dialogs/gateway.ts`); this
 * file covers starting one, the history, reading a single conversation, and ending it when the
 * socket has already dropped.
 */

// The mode is still accepted: builds in the wild send it. The agent has one way of talking so far, so it
// goes nowhere; a second mode brings it back into the call, as an added field.
const startBody = z.object({
  mode: z.enum(DialogMode).optional(),
})

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.string().min(1).max(200).optional(),
})

const endBody = z.object({
  takeaway: z.string().max(InputLimit.TakeawayMax).optional(),
  tensionAfter: z.coerce.number().int().min(1).max(10).optional(),
})

export function dialogsRoutes(app: Hono<AppEnv>, { jwt, rateLimiter, sessions }: RouteDeps): void {
  // Starting a conversation is what an ended session must not be able to do on the access token it
  // still holds: it opens a dialog at the agent.
  app.post(
    ApiPath.Dialogs,
    requireAuth(jwt),
    requireActiveSession(sessions),
    jsonBody(startBody),
    async (c) => {
      const { userId } = authUser(c)
      if (!(await rateLimiter.hit(`user:dialog-start:${userId}`, RATE_LIMITS.dialogStart.perUser))) {
        return apiError(c, 429, 'Too many dialog starts')
      }
      const result = await dialogsProcess.execute(new StartDialogOperation({ userId }))
      if (!result.success) {
        switch (result.error) {
          case StartDialogOperationErrorCode.USER_NOT_FOUND:
            return apiRefused(c, StartDialogApiErrorCode.USER_NOT_FOUND, 'User not found')
          case StartDialogOperationErrorCode.USER_INACTIVE:
            return apiRefused(c, StartDialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
          case StartDialogOperationErrorCode.CONSENT_REQUIRED:
            return apiRefused(c, StartDialogApiErrorCode.CONSENT_REQUIRED, 'The terms have not been accepted')
          default:
            return assertNever(result.error)
        }
      }
      const response: StartDialogApiResponse = result.dialog
      return apiOk(c, response)
    },
  )

  app.get(ApiPath.Dialogs, requireAuth(jwt), queryParams(listQuery), async (c) => {
    const { limit, before } = c.req.valid('query')
    const result = await dialogsProcess.execute(
      new ListDialogsOperation({ userId: authUser(c).userId, limit: limit ?? 20, before: before ?? null }),
    )
    if (!result.success) {
      switch (result.error) {
        case ListDialogsOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case ListDialogsOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        default:
          return assertNever(result.error)
      }
    }
    const response: ListDialogsApiResponse = {
      items: result.items.map(toDialogListItem),
      next: result.next,
    }
    return apiOk(c, response)
  })

  app.get(`${ApiPath.Dialogs}/:dialogId`, requireAuth(jwt), async (c) => {
    const result = await dialogsProcess.execute(
      new GetDialogOperation({ userId: authUser(c).userId, dialogId: c.req.param('dialogId') }),
    )
    if (!result.success) {
      switch (result.error) {
        case GetDialogOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case GetDialogOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        case GetDialogOperationErrorCode.DIALOG_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.DIALOG_NOT_FOUND, 'Dialog not found')
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, toDialog(result.dialog))
  })

  app.post(`${ApiPath.Dialogs}/:dialogId/end`, requireAuth(jwt), jsonBody(endBody), async (c) => {
    const body = c.req.valid('json')
    const result = await dialogsProcess.execute(
      new EndDialogOperation({
        userId: authUser(c).userId,
        dialogId: c.req.param('dialogId'),
        takeaway: body.takeaway ?? null,
        tensionAfter: body.tensionAfter ?? null,
      }),
    )
    if (!result.success) {
      switch (result.error) {
        case EndDialogOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case EndDialogOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        case EndDialogOperationErrorCode.DIALOG_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.DIALOG_NOT_FOUND, 'Dialog not found')
        default:
          return assertNever(result.error)
      }
    }
    const response: EndDialogApiResponse = { summary: toDialogSummary(result.summary) }
    return apiOk(c, response)
  })
}
