import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction, validateInput } from '../../../shared'
import {
  agentApiIntegration,
  UpdateAgentMemorySettingsRequest,
  UpdateAgentMemorySettingsRequestErrorCode,
} from '../../../integrations/agent-api'
import {
  RecordUserConsentCommand,
  RecordUserConsentCommandErrorCode,
  userConsentsManager,
} from '../../../managers/user-consents-manager'
import {
  GetLatestMemoryConsentEventQuery,
  memoryConsentEventsManager,
  RecordMemoryConsentEventCommand,
} from '../../../managers/memory-consent-events-manager'
import { isLiveUser } from '../shared/ensure-live-user'
import { toMemorySettingsDTO } from '../shared/memory.dto'
import { UpdateMemorySettingsOperation } from './update-memory-settings.operation'
import {
  UpdateMemorySettingsOperationErrorCode,
  type UpdateMemorySettingsResult,
} from './update-memory-settings.types'
import { updateMemorySettingsSchema } from './update-memory-settings.validator'

/**
 * The person's switch "Remember". Memory is opt-in: it is turned on only together with the consent
 * sheet, never by default, and nothing else in the app depends on it.
 *
 * Turning on records the consent first (`user_consents`, kind `memory`, in the version of the sheet;
 * a repeat of the same version keeps the first acceptance) and a `granted` line in the memory consent
 * journal, and only then asks the agent. If the agent refuses or is down, the consent stays on
 * record: it is harmless, the person did accept, and memory is not on until the agent says so.
 *
 * Turning off writes a `revoked` line, with the version that was in force, before the agent is
 * asked: withdrawing consent counts from the moment the person did it. Turning off what was never
 * on leaves no line. Whether memory is on is the agent's to say; the journal is the evidence.
 */
@requestHandler(UpdateMemorySettingsOperation)
export class UpdateMemorySettingsOperationHandler implements RequestHandler<
  UpdateMemorySettingsOperation,
  UpdateMemorySettingsResult
> {
  async handle(operation: UpdateMemorySettingsOperation): Promise<UpdateMemorySettingsResult> {
    const input = validateInput(updateMemorySettingsSchema, { consentVersion: operation.consentVersion })
    const userId = operation.userId
    if (!(await isLiveUser(userId))) {
      return { success: false, error: UpdateMemorySettingsOperationErrorCode.USER_NOT_FOUND }
    }
    if (operation.enabled === true && (!operation.consentAccepted || input.consentVersion === null)) {
      return { success: false, error: UpdateMemorySettingsOperationErrorCode.CONSENT_REQUIRED }
    }

    const at = new Date()
    if (operation.enabled === true && input.consentVersion !== null) {
      const version = input.consentVersion
      await inTransaction(async () => {
        const recorded = await userConsentsManager.execute(
          new RecordUserConsentCommand({
            recordId: randomUUID(),
            userId,
            kind: 'memory',
            version,
            acceptedAt: at,
          }),
        )
        if (!recorded.success) {
          switch (recorded.error) {
            // Turned on again under the same sheet: the first acceptance stands.
            case RecordUserConsentCommandErrorCode.CONSENT_ALREADY_RECORDED:
              break
            default:
              assertNever(recorded.error)
          }
        }
        const { event } = await memoryConsentEventsManager.execute(
          new GetLatestMemoryConsentEventQuery({ userId }),
        )
        // A double tap or a retry of the same consent is not a new one.
        if (event?.action !== 'granted' || event.version !== version) {
          await memoryConsentEventsManager.execute(
            new RecordMemoryConsentEventCommand({
              eventId: randomUUID(),
              userId,
              action: 'granted',
              version,
              at,
            }),
          )
        }
      })
    } else if (operation.enabled === false) {
      await inTransaction(async () => {
        const { event } = await memoryConsentEventsManager.execute(
          new GetLatestMemoryConsentEventQuery({ userId }),
        )
        // Only consent in force can be withdrawn, and a repeat withdraws nothing more.
        if (event?.action === 'granted') {
          await memoryConsentEventsManager.execute(
            new RecordMemoryConsentEventCommand({
              eventId: randomUUID(),
              userId,
              action: 'revoked',
              version: event.version,
              at,
            }),
          )
        }
      })
    }

    const updated = await agentApiIntegration.execute(
      new UpdateAgentMemorySettingsRequest({
        userId,
        enabled: operation.enabled,
        consentVersion: operation.enabled === true ? input.consentVersion : null,
        sensitiveEnabled: operation.sensitiveEnabled,
        chatSearchEnabled: operation.chatSearchEnabled,
      }),
    )
    if (!updated.success) {
      switch (updated.error) {
        case UpdateAgentMemorySettingsRequestErrorCode.MEMORY_UNAVAILABLE:
          return { success: false, error: UpdateMemorySettingsOperationErrorCode.MEMORY_UNAVAILABLE }
        case UpdateAgentMemorySettingsRequestErrorCode.MEMORY_NOT_ALLOWED:
          return { success: false, error: UpdateMemorySettingsOperationErrorCode.MEMORY_NOT_ALLOWED }
        // The version was checked above: the agent disagreeing with it is a bug, not the person's doing.
        case UpdateAgentMemorySettingsRequestErrorCode.INVALID_REQUEST:
          throw new Error('Agent API did not accept the memory settings')
        default:
          return assertNever(updated.error)
      }
    }
    createLogger('memory').info('Memory switched', {
      userId,
      enabled: updated.settings.enabled,
      consentVersion: updated.settings.consentVersion,
    })
    return { success: true, settings: toMemorySettingsDTO(updated.settings) }
  }
}
