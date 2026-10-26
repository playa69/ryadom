import { consentVersionInputSchema, memoryFactTextInputSchema } from '@ryadom/core/config'
import {
  CreateMemoryFactOperation,
  CreateMemoryFactOperationErrorCode,
  ExportMemoryOperation,
  ExportMemoryOperationErrorCode,
  ForgetMemoryFactOperation,
  ForgetMemoryFactOperationErrorCode,
  ForgetMemoryOperation,
  ForgetMemoryOperationErrorCode,
  GetMemoryChangesOperation,
  GetMemoryChangesOperationErrorCode,
  GetMemoryOperation,
  GetMemoryOperationErrorCode,
  memoryProcess,
  MemoryInstructionOperation,
  MemoryInstructionOperationErrorCode,
  UpdateMemoryFactOperation,
  UpdateMemoryFactOperationErrorCode,
  UpdateMemorySettingsOperation,
  UpdateMemorySettingsOperationErrorCode,
  type MemoryFactSlotsDTO,
} from '@ryadom/core/processes/memory'
import assertNever from 'assert-never'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import {
  CreateMemoryFactApiErrorCode,
  ForgetMemoryApiErrorCode,
  GetMemoryApiErrorCode,
  MemoryChangesApiErrorCode,
  MemoryFactCategory,
  MemoryFactStatus,
  MemoryInstructionApiErrorCode,
  UpdateMemoryFactApiErrorCode,
  UpdateMemorySettingsApiErrorCode,
} from '@ryadom/contracts/api/memory'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import {
  fromMemoryFactCategory,
  toMemoryInstruction,
  toMemory,
  toMemoryChanges,
  toMemoryExport,
  toMemoryFact,
  toMemorySettings,
} from '../../lib/mappers'
import { RATE_LIMITS, type RateLimiter, type RateLimitRule } from '../../lib/rate-limit'
import { jsonBody, queryParams } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * The agent's memory of the person (`/api/memory...`): what it remembers, the switch "Remember" with
 * its consent, the person's own corrections, "forget" one fact or everything, the "I remembered" card
 * after a conversation and the download. Memory lives at the agent; these routes only let the person
 * reach their own: the user always comes from the token, never from the body or the path.
 *
 * Every route needs an open session, reading included: what is remembered is the most private thing
 * the app holds, and a device that was signed out must not read it on a token that has not expired.
 *
 * The texts of facts travel to their owner and nowhere else: not into a log, not into analytics, not
 * into an error message. A refusal by the agent's rules says which rule (`FACT_REJECTED: contact_pii`)
 * in the log line, never what was refused.
 */

// Shape only (a 400): the lengths of the slots and what may be remembered are the agent's rules.
const slotsBody = z
  .object({
    address: z.string().max(200).optional(),
    form: z.enum(['ty', 'vy']).optional(),
    length: z.enum(['short', 'normal']).optional(),
    advice: z.enum(['ask_first', 'ok']).optional(),
    tone: z.enum(['soft', 'direct']).optional(),
    role: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
    note: z.string().max(200).optional(),
  })
  .strict()

const settingsBody = z.object({
  enabled: z.boolean().optional(),
  sensitiveEnabled: z.boolean().optional(),
  chatSearchEnabled: z.boolean().optional(),
  consentAccepted: z.boolean().optional(),
  consentVersion: z.string().max(40).optional(),
}).refine((body) => body.enabled !== undefined || body.sensitiveEnabled !== undefined || body.chatSearchEnabled !== undefined, {
  message: 'Nothing to change',
})

const instructionBody = z.object({
  text: z.string().trim().min(1).max(1000),
})

const createFactBody = z.object({
  category: z.enum(MemoryFactCategory),
  text: z.string().max(4000).optional(),
  slots: slotsBody.optional(),
})

const updateFactBody = z
  .object({
    text: z.string().max(4000).optional(),
    slots: slotsBody.optional(),
    status: z.enum([MemoryFactStatus.Active, MemoryFactStatus.Pinned]).optional(),
    confirm: z.literal(true).optional(),
  })
  .refine(
    (body) =>
      body.text !== undefined ||
      body.slots !== undefined ||
      body.status !== undefined ||
      body.confirm !== undefined,
    'nothing to change',
  )

// The agent takes a dialog id of up to 64 characters (its ids are UUIDs) and refuses a longer one.
const changesQuery = z.object({
  dialogId: z.string().min(1).max(64),
})

/** The categories whose text the agent builds from their slots: they take no text of their own. */
const SLOT_CATEGORIES: ReadonlySet<MemoryFactCategory> = new Set([
  MemoryFactCategory.Style,
  MemoryFactCategory.Person,
])

/** A fact id longer than this is not one the agent gave out. */
const FACT_ID_MAX = 200

function perUser(limiter: RateLimiter, name: string, rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(await limiter.hit(`user:${name}:${authUser(c).userId}`, rule))) {
      return apiError(c, 429, 'Too many memory requests')
    }
    return next()
  }
}

function slotsOf(slots: z.infer<typeof slotsBody> | undefined): MemoryFactSlotsDTO | undefined {
  if (!slots) return undefined
  const dto: MemoryFactSlotsDTO = {}
  if (slots.address !== undefined) dto.address = slots.address
  if (slots.form !== undefined) dto.form = slots.form
  if (slots.length !== undefined) dto.length = slots.length
  if (slots.advice !== undefined) dto.advice = slots.advice
  if (slots.tone !== undefined) dto.tone = slots.tone
  if (slots.role !== undefined) dto.role = slots.role
  if (slots.name !== undefined) dto.name = slots.name
  if (slots.note !== undefined) dto.note = slots.note
  return dto
}

/** The text of a fact as the person wrote it, trimmed, or null when it breaks the length rule. */
function factTextOf(
  c: Context<AppEnv>,
  text: string | undefined,
): { ok: true; text: string | undefined } | { ok: false; response: Response } {
  if (text === undefined) return { ok: true, text: undefined }
  const valid = inputOrNull(memoryFactTextInputSchema, text)
  if (valid === null) return { ok: false, response: apiError(c, 422, 'The fact must be 1 to 200 characters') }
  return { ok: true, text: valid }
}

/** For the log line only: the code of the agent's rule, never the refused text. */
function rejectedMessage(reason: string | null): string {
  return reason
    ? `The fact is not allowed by the memory rules: ${reason}`
    : 'The fact is not allowed by the memory rules'
}

export function memoryRoutes(app: Hono<AppEnv>, { jwt, rateLimiter, sessions }: RouteDeps): void {
  const signedIn = [requireAuth(jwt), requireActiveSession(sessions)] as const
  const read = perUser(rateLimiter, 'memory-read', RATE_LIMITS.memoryRead.perUser)
  const write = perUser(rateLimiter, 'memory-write', RATE_LIMITS.memoryWrite.perUser)

  // GET /api/memory: the "Memory" screen. Works with memory off and while the feature is unavailable.
  app.get(ApiPath.Memory, ...signedIn, read, async (c) => {
    const result = await memoryProcess.execute(new GetMemoryOperation({ userId: authUser(c).userId }))
    if (!result.success) {
      switch (result.error) {
        case GetMemoryOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, GetMemoryApiErrorCode.USER_NOT_FOUND, 'User not found')
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, toMemory(result.memory))
  })

  // DELETE /api/memory: "Forget everything". Conversations, the switch and the consent stay.
  app.delete(ApiPath.Memory, ...signedIn, write, async (c) => {
    const result = await memoryProcess.execute(new ForgetMemoryOperation({ userId: authUser(c).userId }))
    if (!result.success) {
      switch (result.error) {
        case ForgetMemoryOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, ForgetMemoryApiErrorCode.USER_NOT_FOUND, 'User not found')
        case ForgetMemoryOperationErrorCode.MEMORY_UNAVAILABLE:
          return apiRefused(c, ForgetMemoryApiErrorCode.MEMORY_UNAVAILABLE, 'Memory is unavailable right now')
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, null)
  })

  // PUT /api/memory/settings: the switch. Turning on needs the consent sheet accepted, in its version.
  app.put(ApiPath.MemorySettings, ...signedIn, write, jsonBody(settingsBody), async (c) => {
    const body = c.req.valid('json')
    let consentVersion: string | null = null
    if (body.consentVersion !== undefined) {
      consentVersion = inputOrNull(consentVersionInputSchema, body.consentVersion)
      if (consentVersion === null) return apiError(c, 422, 'The version of the memory consent is not a date')
    }
    const result = await memoryProcess.execute(
      new UpdateMemorySettingsOperation({
        userId: authUser(c).userId,
        enabled: body.enabled,
        sensitiveEnabled: body.sensitiveEnabled,
        chatSearchEnabled: body.chatSearchEnabled,
        consentAccepted: body.consentAccepted === true,
        consentVersion,
      }),
    )
    if (!result.success) {
      switch (result.error) {
        case UpdateMemorySettingsOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, UpdateMemorySettingsApiErrorCode.USER_NOT_FOUND, 'User not found')
        case UpdateMemorySettingsOperationErrorCode.CONSENT_REQUIRED:
          return apiRefused(
            c,
            UpdateMemorySettingsApiErrorCode.CONSENT_REQUIRED,
            'Memory is turned on only with the consent accepted',
          )
        case UpdateMemorySettingsOperationErrorCode.MEMORY_UNAVAILABLE:
          return apiRefused(
            c,
            UpdateMemorySettingsApiErrorCode.MEMORY_UNAVAILABLE,
            'Memory is unavailable right now',
          )
        case UpdateMemorySettingsOperationErrorCode.MEMORY_NOT_ALLOWED:
          return apiRefused(
            c,
            UpdateMemorySettingsApiErrorCode.MEMORY_NOT_ALLOWED,
            'Memory is not open to this account',
          )
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, toMemorySettings(result.settings))
  })

  // POST /api/memory/facts: the person writes a fact themselves.
  app.post(ApiPath.MemoryFacts, ...signedIn, write, jsonBody(createFactBody), async (c) => {
    const body = c.req.valid('json')
    // The shape the category takes (a 400, as the agent would refuse it anyway): slots for `style` and
    // `person`, a text for the rest.
    if (
      SLOT_CATEGORIES.has(body.category) ? body.text !== undefined || !body.slots : body.text === undefined
    ) {
      return apiError(
        c,
        400,
        `Invalid request body: ${body.category} takes ${SLOT_CATEGORIES.has(body.category) ? 'slots only' : 'a text'}`,
      )
    }
    const text = factTextOf(c, body.text)
    if (!text.ok) return text.response
    const result = await memoryProcess.execute(
      new CreateMemoryFactOperation({
        userId: authUser(c).userId,
        category: fromMemoryFactCategory(body.category),
        text: text.text ?? null,
        slots: slotsOf(body.slots) ?? null,
      }),
    )
    if (!result.success) {
      switch (result.error) {
        case CreateMemoryFactOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, CreateMemoryFactApiErrorCode.USER_NOT_FOUND, 'User not found')
        case CreateMemoryFactOperationErrorCode.MEMORY_DISABLED:
          return apiRefused(c, CreateMemoryFactApiErrorCode.MEMORY_DISABLED, 'Memory is turned off')
        case CreateMemoryFactOperationErrorCode.MEMORY_FULL:
          return apiRefused(c, CreateMemoryFactApiErrorCode.MEMORY_FULL, 'Memory is full')
        case CreateMemoryFactOperationErrorCode.FACT_REJECTED:
          return apiRefused(c, CreateMemoryFactApiErrorCode.FACT_REJECTED, rejectedMessage(result.reason))
        case CreateMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE:
          return apiRefused(
            c,
            CreateMemoryFactApiErrorCode.MEMORY_UNAVAILABLE,
            'Memory is unavailable right now',
          )
        case CreateMemoryFactOperationErrorCode.INVALID_FACT:
          return apiError(c, 422, 'The fact does not fit its category')
        default:
          return assertNever(result)
      }
    }
    return apiOk(c, toMemoryFact(result.fact))
  })

  // PATCH /api/memory/facts/:factId: correct, "Remember", pin or unpin, "Right".
  app.patch(`${ApiPath.MemoryFacts}/:factId`, ...signedIn, write, jsonBody(updateFactBody), async (c) => {
    const factId = c.req.param('factId')
    if (factId.length > FACT_ID_MAX) {
      return apiRefused(c, UpdateMemoryFactApiErrorCode.FACT_NOT_FOUND, 'Fact not found')
    }
    const body = c.req.valid('json')
    const text = factTextOf(c, body.text)
    if (!text.ok) return text.response
    const result = await memoryProcess.execute(
      new UpdateMemoryFactOperation({
        userId: authUser(c).userId,
        factId,
        text: text.text,
        slots: slotsOf(body.slots),
        status:
          body.status === undefined
            ? undefined
            : body.status === MemoryFactStatus.Pinned
              ? 'pinned'
              : 'active',
        confirm: body.confirm,
      }),
    )
    if (!result.success) {
      switch (result.error) {
        case UpdateMemoryFactOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, UpdateMemoryFactApiErrorCode.USER_NOT_FOUND, 'User not found')
        case UpdateMemoryFactOperationErrorCode.MEMORY_DISABLED:
          return apiRefused(c, UpdateMemoryFactApiErrorCode.MEMORY_DISABLED, 'Memory is turned off')
        case UpdateMemoryFactOperationErrorCode.FACT_NOT_FOUND:
          return apiRefused(c, UpdateMemoryFactApiErrorCode.FACT_NOT_FOUND, 'Fact not found')
        case UpdateMemoryFactOperationErrorCode.FACT_REJECTED:
          return apiRefused(c, UpdateMemoryFactApiErrorCode.FACT_REJECTED, rejectedMessage(result.reason))
        case UpdateMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE:
          return apiRefused(
            c,
            UpdateMemoryFactApiErrorCode.MEMORY_UNAVAILABLE,
            'Memory is unavailable right now',
          )
        case UpdateMemoryFactOperationErrorCode.INVALID_FACT:
          return apiError(c, 422, 'The change does not fit the fact')
        default:
          return assertNever(result)
      }
    }
    return apiOk(c, toMemoryFact(result.fact))
  })

  // DELETE /api/memory/facts/:factId: "Forget" (or "Don't remember" a proposed one). A repeat succeeds.
  app.delete(`${ApiPath.MemoryFacts}/:factId`, ...signedIn, write, async (c) => {
    const factId = c.req.param('factId')
    // Nothing the agent gave out: there is nothing to forget.
    if (factId.length > FACT_ID_MAX) return apiOk(c, null)
    const result = await memoryProcess.execute(
      new ForgetMemoryFactOperation({ userId: authUser(c).userId, factId }),
    )
    if (!result.success) {
      switch (result.error) {
        case ForgetMemoryFactOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, ForgetMemoryApiErrorCode.USER_NOT_FOUND, 'User not found')
        case ForgetMemoryFactOperationErrorCode.MEMORY_UNAVAILABLE:
          return apiRefused(c, ForgetMemoryApiErrorCode.MEMORY_UNAVAILABLE, 'Memory is unavailable right now')
        case ForgetMemoryFactOperationErrorCode.UNSUPPORTED:
          return apiRefused(
            c,
            ForgetMemoryApiErrorCode.FACT_UNSUPPORTED,
            'Forgetting a single fact is not supported right now',
          )
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, null)
  })

  // GET /api/memory/changes?dialogId=: the "I remembered" card after a conversation.
  app.get(ApiPath.MemoryChanges, ...signedIn, read, queryParams(changesQuery), async (c) => {
    const { dialogId } = c.req.valid('query')
    const result = await memoryProcess.execute(
      new GetMemoryChangesOperation({ userId: authUser(c).userId, dialogId }),
    )
    if (!result.success) {
      switch (result.error) {
        case GetMemoryChangesOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, MemoryChangesApiErrorCode.USER_NOT_FOUND, 'User not found')
        case GetMemoryChangesOperationErrorCode.DIALOG_NOT_FOUND:
          return apiRefused(c, MemoryChangesApiErrorCode.DIALOG_NOT_FOUND, 'Dialog not found')
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, toMemoryChanges(result.changes))
  })

  // POST /api/memory/notes/instruction: "Tell Ryadom what to correct or remove". The text is the person's own words.
  app.post(ApiPath.MemoryInstruction, ...signedIn, write, jsonBody(instructionBody), async (c) => {
    const { text } = c.req.valid('json')
    const result = await memoryProcess.execute(
      new MemoryInstructionOperation({ userId: authUser(c).userId, text }),
    )
    if (!result.success) {
      switch (result.error) {
        case MemoryInstructionOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, MemoryInstructionApiErrorCode.USER_NOT_FOUND, 'User not found')
        case MemoryInstructionOperationErrorCode.MEMORY_DISABLED:
          return apiRefused(c, MemoryInstructionApiErrorCode.MEMORY_DISABLED, 'Memory is turned off')
        case MemoryInstructionOperationErrorCode.MEMORY_UNAVAILABLE:
          return apiRefused(
            c,
            MemoryInstructionApiErrorCode.MEMORY_UNAVAILABLE,
            'Memory is unavailable right now',
          )
        default:
          return assertNever(result.error)
      }
    }
    return apiOk(c, toMemoryInstruction(result.changes))
  })

  // GET /api/memory/export: "Download my memory". Works with memory off and while it is unavailable.
  app.get(
    ApiPath.MemoryExport,
    ...signedIn,
    perUser(rateLimiter, 'memory-export', RATE_LIMITS.memoryExport.perUser),
    async (c) => {
      const result = await memoryProcess.execute(new ExportMemoryOperation({ userId: authUser(c).userId }))
      if (!result.success) {
        switch (result.error) {
          case ExportMemoryOperationErrorCode.USER_NOT_FOUND:
            return apiRefused(c, GetMemoryApiErrorCode.USER_NOT_FOUND, 'User not found')
          default:
            return assertNever(result.error)
        }
      }
      return apiOk(c, toMemoryExport(result.export))
    },
  )
}
