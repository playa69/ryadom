import { recomputeSummariesAfterDialogDeleted } from '@ryadom/core/processes/diary'
import {
  DeleteDialogOperation,
  DeleteDialogOperationErrorCode,
  DraftRecapOperation,
  DraftRecapOperationErrorCode,
  GetDialogSettingsOperation,
  GetDialogSettingsOperationErrorCode,
  ListRecapsOperation,
  ListRecapsOperationErrorCode,
  PutDialogSettingsOperation,
  PutDialogSettingsOperationErrorCode,
  PutRecapOperation,
  PutRecapOperationErrorCode,
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
  DialogRecapApiErrorCode,
  RECAP_MAX,
  StartDialogApiErrorCode,
  type DeleteDialogApiResponse,
  type DialogSettingsApiResponse,
  type DraftDialogRecapApiResponse,
  type EndDialogApiResponse,
  type ListDialogRecapsApiResponse,
  type PutDialogRecapApiResponse,
  type ListDialogsApiResponse,
  type StartDialogApiResponse,
} from '@ryadom/contracts/api/dialogs'
import { DialogMemoryMode } from '@ryadom/contracts/api/memory'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { dialogIdProperty, messageCounts, tensionOutcome } from '../../lib/analytics'
import { createLogger } from '@ryadom/core/shared'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import {
  fromDialogMemoryMode,
  toDialog,
  toDialogListItem,
  toDialogMemoryMode,
  toDialogSummary,
  toRecapItem,
} from '../../lib/mappers'
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
  // The person's answer to "continue the open dialog or end it and begin a new one"; without it a start changes nothing.
  startNew: z.boolean().optional(),
  // "Without memory" for a new dialog; a returned open one keeps its own mode.
  memory: z.enum(DialogMemoryMode).optional(),
  // `false`: "Не сохранять этот разговор", a choice of its own, apart from `memory`. Absent in the builds that came before it.
  saved: z.boolean().optional(),
})

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.string().min(1).max(200).optional(),
})

const endBody = z.object({
  takeaway: z.string().max(InputLimit.TakeawayMax).optional(),
  tensionAfter: z.coerce.number().int().min(1).max(10).optional(),
  recapSource: z.enum(['manual', 'draft']).optional(),
})

const putRecapBody = z.object({
  recap: z.string().trim().min(1).max(RECAP_MAX),
  source: z.enum(['manual', 'draft']).optional(),
})
const settingsBody = z.object({ recapEnabled: z.boolean() })

export function dialogsRoutes(app: Hono<AppEnv>, { jwt, rateLimiter, sessions, analytics }: RouteDeps): void {
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
      const { startNew, memory, saved } = c.req.valid('json')
      const result = await dialogsProcess.execute(
        new StartDialogOperation({
          userId,
          startNew,
          memory: memory === undefined ? undefined : fromDialogMemoryMode(memory),
          saved,
        }),
      )
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
      const response: StartDialogApiResponse = {
        dialogId: result.dialog.dialogId,
        resumed: result.dialog.resumed,
        greeting: result.dialog.greeting,
        sinceLastDialogHours: result.dialog.sinceLastDialogHours,
        messageCount: result.dialog.messageCount,
        lastActivityAt: result.dialog.lastActivityAt,
        memoryMode: toDialogMemoryMode(result.dialog.memoryMode),
        saved: result.dialog.saved,
        memoryEnabled: result.dialog.memoryEnabled,
      }
      // A conversation held unsaved is not reported anywhere: neither its start nor its end nor its turns.
      if (result.dialog.saved) {
        analytics.capture(userId, AnalyticsEvent.DialogStarted, {
          ...dialogIdProperty(result.dialog.dialogId),
          resumed: result.dialog.resumed,
          hours_since_last:
            result.dialog.sinceLastDialogHours === null ? null : Math.round(result.dialog.sinceLastDialogHours),
        })
      }
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
        recapSource: body.recapSource ?? 'manual',
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
    if (result.saved) {
      analytics.capture(authUser(c).userId, AnalyticsEvent.DialogEnded, {
        ...dialogIdProperty(c.req.param('dialogId')),
        via: 'rest',
        ...messageCounts(result.summary),
        has_takeaway: body.takeaway !== undefined && body.takeaway !== '',
        ...tensionOutcome(response.summary),
      })
    }
    return apiOk(c, response)
  })

  // «Удалить разговор» in the journal: the agent deletes the conversation with its recap, the share link goes out, and the
  // week summary of that week is dropped at once (the diary writes it again from what is left). The facts of memory stay.
  app.delete(`${ApiPath.Dialogs}/:dialogId`, requireAuth(jwt), requireActiveSession(sessions), async (c) => {
    const { userId } = authUser(c)
    if (!(await rateLimiter.hit(`user:dialog-delete:${userId}`, RATE_LIMITS.dialogRecap.perUser))) {
      return apiError(c, 429, 'Too many requests')
    }
    const result = await dialogsProcess.execute(
      new DeleteDialogOperation({ userId, dialogId: c.req.param('dialogId') }),
    )
    if (!result.success) {
      switch (result.error) {
        case DeleteDialogOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case DeleteDialogOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        case DeleteDialogOperationErrorCode.DIALOG_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.DIALOG_NOT_FOUND, 'Dialog not found')
        default:
          return assertNever(result.error)
      }
    }
    // The conversation is gone for good: a failure of the diary must not undo that, the tick catches the week up by the text.
    try {
      await recomputeSummariesAfterDialogDeleted({ userId, dialogAt: result.startedAt })
    } catch (error) {
      createLogger('dialogs').error('Week summary reset after a deleted dialog failed', error)
    }
    const response: DeleteDialogApiResponse = { deleted: true }
    return apiOk(c, response)
  })

  app.get(ApiPath.DialogRecaps, requireAuth(jwt), queryParams(listQuery), async (c) => {
    const { limit, before } = c.req.valid('query')
    const result = await dialogsProcess.execute(
      new ListRecapsOperation({ userId: authUser(c).userId, limit: limit ?? 20, before: before ?? null }),
    )
    if (!result.success) {
      switch (result.error) {
        case ListRecapsOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case ListRecapsOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        default:
          return assertNever(result.error)
      }
    }
    const response: ListDialogRecapsApiResponse = { items: result.items.map(toRecapItem), next: result.next }
    return apiOk(c, response)
  })

  // «Предзаполнить»: the model writes a draft, nothing is saved. It costs a model call, hence its own limit.
  app.post(`${ApiPath.Dialogs}/:dialogId/recap/draft`, requireAuth(jwt), requireActiveSession(sessions), async (c) => {
    const { userId } = authUser(c)
    if (!(await rateLimiter.hit(`user:dialog-recap-draft:${userId}`, RATE_LIMITS.dialogRecapDraft.perUser))) {
      return apiError(c, 429, 'Too many requests')
    }
    const result = await dialogsProcess.execute(new DraftRecapOperation({ userId, dialogId: c.req.param('dialogId') }))
    if (!result.success) {
      switch (result.error) {
        case DraftRecapOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogRecapApiErrorCode.USER_NOT_FOUND, 'User not found')
        case DraftRecapOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogRecapApiErrorCode.USER_INACTIVE, 'Account is inactive')
        case DraftRecapOperationErrorCode.DIALOG_NOT_FOUND:
          return apiRefused(c, DialogRecapApiErrorCode.DIALOG_NOT_FOUND, 'Dialog not found')
        case DraftRecapOperationErrorCode.RECAP_NOT_AVAILABLE:
          return apiRefused(c, DialogRecapApiErrorCode.RECAP_NOT_AVAILABLE, 'No recap for this conversation')
        case DraftRecapOperationErrorCode.UNAVAILABLE:
          return apiRefused(c, DialogRecapApiErrorCode.RECAP_UNAVAILABLE, 'The draft could not be written')
        default:
          return assertNever(result.error)
      }
    }
    const response: DraftDialogRecapApiResponse = { recap: result.recap }
    return apiOk(c, response)
  })

  app.put(
    `${ApiPath.Dialogs}/:dialogId/recap`,
    requireAuth(jwt),
    requireActiveSession(sessions),
    jsonBody(putRecapBody),
    async (c) => {
      const { userId } = authUser(c)
      const { source, recap } = c.req.valid('json')
      const result = await dialogsProcess.execute(
        new PutRecapOperation({ userId, dialogId: c.req.param('dialogId'), recap, source: source ?? 'manual' }),
      )
      if (!result.success) {
        switch (result.error) {
          case PutRecapOperationErrorCode.USER_NOT_FOUND:
            return apiRefused(c, DialogRecapApiErrorCode.USER_NOT_FOUND, 'User not found')
          case PutRecapOperationErrorCode.USER_INACTIVE:
            return apiRefused(c, DialogRecapApiErrorCode.USER_INACTIVE, 'Account is inactive')
          case PutRecapOperationErrorCode.DIALOG_NOT_FOUND:
            return apiRefused(c, DialogRecapApiErrorCode.DIALOG_NOT_FOUND, 'Dialog not found')
          case PutRecapOperationErrorCode.RECAP_NOT_AVAILABLE:
            return apiRefused(c, DialogRecapApiErrorCode.RECAP_NOT_AVAILABLE, 'No recap for this conversation')
          default:
            return assertNever(result.error)
        }
      }
      const response: PutDialogRecapApiResponse = { summary: toDialogSummary(result.summary) }
      return apiOk(c, response)
    },
  )

  app.get(ApiPath.DialogSettings, requireAuth(jwt), async (c) => {
    const result = await dialogsProcess.execute(new GetDialogSettingsOperation({ userId: authUser(c).userId }))
    if (!result.success) {
      switch (result.error) {
        case GetDialogSettingsOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case GetDialogSettingsOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        default:
          return assertNever(result.error)
      }
    }
    const response: DialogSettingsApiResponse = { recapEnabled: result.recapEnabled }
    return apiOk(c, response)
  })

  app.put(ApiPath.DialogSettings, requireAuth(jwt), requireActiveSession(sessions), jsonBody(settingsBody), async (c) => {
    const result = await dialogsProcess.execute(
      new PutDialogSettingsOperation({ userId: authUser(c).userId, recapEnabled: c.req.valid('json').recapEnabled }),
    )
    if (!result.success) {
      switch (result.error) {
        case PutDialogSettingsOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, DialogApiErrorCode.USER_NOT_FOUND, 'User not found')
        case PutDialogSettingsOperationErrorCode.USER_INACTIVE:
          return apiRefused(c, DialogApiErrorCode.USER_INACTIVE, 'Account is inactive')
        default:
          return assertNever(result.error)
      }
    }
    const response: DialogSettingsApiResponse = { recapEnabled: result.recapEnabled }
    return apiOk(c, response)
  })
}
