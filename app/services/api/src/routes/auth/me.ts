import { nameInputSchema } from '@ryadom/core/config'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  SetUserAnalyticsOptOutCommand,
  SetUserAnalyticsOptOutCommandErrorCode,
  UpdateUserNameCommand,
  UpdateUserNameCommandErrorCode,
  UpdateUserTimezoneCommand,
  UpdateUserTimezoneCommandErrorCode,
  isKnownTimezone,
  UpdateUserVoiceCommand,
  UpdateUserVoiceCommandErrorCode,
  usersManager,
} from '@ryadom/core/managers/users-manager'
import {
  accountDeletionProcess,
  DeleteAccountOperation,
  DeleteAccountOperationErrorCode,
} from '@ryadom/core/processes/account-deletion'
import { GetVoicePipelineQuery, voiceSettingsManager } from '@ryadom/core/managers/voice-settings-manager'
import { consentsProcess, GetConsentStatusOperation } from '@ryadom/core/processes/consents'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { AnalyticsEvent, type ProfileField } from '@ryadom/analytics/events'
import { findVoice } from '@ryadom/contracts/voices'
import { AGENT_VOICES, MeApiErrorCode, type MeApiResponse } from '@ryadom/contracts/api/auth/me'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { toMe } from '../../lib/mappers'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * Profile: GET, PATCH (name, the agent's voice and/or the person's choice about product analytics),
 * DELETE ("erase everything").
 */

const patchBody = z.object({
  name: z.string().optional(),
  voice: z.enum(AGENT_VOICES).optional(),
  voiceName: z.string().optional(),
  analyticsOptOut: z.boolean().optional(),
  timezone: z.string().optional(),
})

/** The profile in contract shape; null means there is no such user. Shared by GET and PATCH. */
async function readMe(userId: string): Promise<MeApiResponse | null> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  if (!found.success) {
    switch (found.error) {
      case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
        return null
      default:
        return assertNever(found.error)
    }
  }
  const { status } = await consentsProcess.execute(new GetConsentStatusOperation({ userId }))
  // The path is the profile's too: on the Sber path one voice speaks whatever the person chose.
  const { settings } = await voiceSettingsManager.execute(new GetVoicePipelineQuery())
  return toMe(found.user, status, settings.pipeline)
}

export function meRoutes(app: Hono<AppEnv>, { jwt, logger, analytics }: RouteDeps): void {
  app.get(ApiPath.Me, requireAuth(jwt), async (c) => {
    const me = await readMe(authUser(c).userId)
    if (!me) return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
    return apiOk(c, me)
  })

  /** The profile can change the name and the agent's voice; the email never changes at all. */
  app.patch(ApiPath.Me, requireAuth(jwt), jsonBody(patchBody), async (c) => {
    const body = c.req.valid('json')
    if (
      body.name === undefined &&
      body.voice === undefined &&
      body.voiceName === undefined &&
      body.analyticsOptOut === undefined &&
      body.timezone === undefined
    ) {
      return apiError(c, 422, 'Nothing to update: send name, voice, voiceName, analyticsOptOut and/or timezone')
    }
    // Both are checked before anything is written: a bad name must not leave a half-applied change.
    const name = body.name === undefined ? undefined : inputOrNull(nameInputSchema, body.name)
    if (name === null) return apiError(c, 422, 'Name length is out of range')
    if (body.timezone !== undefined && !isKnownTimezone(body.timezone)) {
      return apiError(c, 422, 'Unknown IANA time zone')
    }

    // A concrete voice fixes the gender with it: the two cannot be set apart (400 when they disagree).
    const picked = body.voiceName === undefined ? undefined : findVoice(body.voiceName)
    if (body.voiceName !== undefined && !picked) return apiError(c, 400, 'Unknown voiceName')
    if (picked && body.voice !== undefined && body.voice !== picked.gender) {
      return apiError(c, 400, 'voice does not match the gender of voiceName')
    }
    const voice = picked?.gender ?? body.voice

    const { userId } = authUser(c)
    // First, so that a "no" said together with other changes already silences their report.
    if (body.analyticsOptOut !== undefined) {
      const updated = await usersManager.execute(
        new SetUserAnalyticsOptOutCommand({ userId, optOut: body.analyticsOptOut }),
      )
      if (!updated.success) {
        switch (updated.error) {
          case SetUserAnalyticsOptOutCommandErrorCode.USER_NOT_FOUND:
            return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
          default:
            return assertNever(updated.error)
        }
      }
      // The server remembers the answer for a minute; this makes the choice count from the next report.
      analytics.setOptOut(userId, body.analyticsOptOut)
    }
    if (name !== undefined) {
      const updated = await usersManager.execute(new UpdateUserNameCommand({ userId, name }))
      if (!updated.success) {
        switch (updated.error) {
          case UpdateUserNameCommandErrorCode.USER_NOT_FOUND:
            return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
          default:
            return assertNever(updated.error)
        }
      }
    }
    if (voice !== undefined) {
      const updated = await usersManager.execute(
        new UpdateUserVoiceCommand({ userId, voice, voiceName: picked?.id ?? null }),
      )
      if (!updated.success) {
        switch (updated.error) {
          case UpdateUserVoiceCommandErrorCode.USER_NOT_FOUND:
            return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
          default:
            return assertNever(updated.error)
        }
      }
    }

    if (body.timezone !== undefined) {
      const updated = await usersManager.execute(new UpdateUserTimezoneCommand({ userId, timezone: body.timezone }))
      if (!updated.success) {
        switch (updated.error) {
          case UpdateUserTimezoneCommandErrorCode.USER_NOT_FOUND:
            return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
          default:
            return assertNever(updated.error)
        }
      }
    }

    // Which fields changed, never what they changed to. The analytics choice is not one of them: a
    // report about turning reports off would be the thing the person just asked not to have.
    const fields: ProfileField[] = []
    if (name !== undefined) fields.push('name')
    if (voice !== undefined) fields.push('voice')
    if (fields.length > 0) analytics.capture(userId, AnalyticsEvent.ProfileUpdated, { fields })

    const me = await readMe(userId)
    if (!me) return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
    return apiOk(c, me)
  })

  /**
   * "Erase everything": the data held by the agent first, then the account. If the agent does not
   * answer, the core throws `AgentUnavailableError`, the error handler replies 503 and the account
   * stays in place, because the promise "we erased everything" was not kept.
   *
   * The session is not revoked separately: the access token lives out its 15 minutes and
   * `/api/auth/refresh` will not renew it, answering `ACCOUNT_DELETED`. The app signs out by itself
   * after a success.
   */
  app.delete(ApiPath.Me, requireAuth(jwt), async (c) => {
    const { userId } = authUser(c)
    const result = await accountDeletionProcess.execute(new DeleteAccountOperation({ userId }))
    if (!result.success) {
      switch (result.error) {
        case DeleteAccountOperationErrorCode.ALREADY_DELETED:
          // A retry after a dropped connection, or two racing requests: the outcome is the one that
          // was asked for, so this counts as success.
          logger.info({ userId }, 'Повторный запрос на удаление уже удалённого аккаунта')
          return apiOk(c, null)
        case DeleteAccountOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, MeApiErrorCode.USER_NOT_FOUND, 'User not found')
        default:
          return assertNever(result.error)
      }
    }
    logger.info({ userId }, 'Аккаунт удалён по запросу пользователя')
    // Counted without the person: someone who has just asked to be erased gets no new record of themselves.
    analytics.captureAnonymous(AnalyticsEvent.AccountDeleted)
    // «Erase everything» includes the pseudonymous profile in PostHog: the erasure was queued with the deletion
    // (`analytics.erase-person`), so it outlives a restart and is retried; the answer does not wait for it.
    return apiOk(c, null)
  })
}
