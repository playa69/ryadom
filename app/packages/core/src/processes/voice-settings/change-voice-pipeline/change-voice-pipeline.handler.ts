import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction } from '../../../shared'
import { auditLogManager, RecordAuditLogEntryCommand } from '../../../managers/audit-log-manager'
import {
  GetVoicePipelineQuery,
  SetVoicePipelineCommand,
  SetVoicePipelineCommandErrorCode,
  voiceSettingsManager,
} from '../../../managers/voice-settings-manager'
import { ChangeVoicePipelineOperation } from './change-voice-pipeline.operation'
import type { ChangeVoicePipelineResult } from './change-voice-pipeline.types'

/**
 * An admin picks the voice pipeline of new conversations. The pipeline and its audit entry are written together; saving
 * the pipeline already in force writes neither. Dialog starts read it on every start, so nothing else needs telling.
 */
@requestHandler(ChangeVoicePipelineOperation)
export class ChangeVoicePipelineOperationHandler implements RequestHandler<
  ChangeVoicePipelineOperation,
  ChangeVoicePipelineResult
> {
  async handle(operation: ChangeVoicePipelineOperation): Promise<ChangeVoicePipelineResult> {
    const changed = await inTransaction(async (): Promise<boolean> => {
      const before = (await voiceSettingsManager.execute(new GetVoicePipelineQuery())).settings.pipeline
      if (before === operation.pipeline) return false
      const set = await voiceSettingsManager.execute(
        new SetVoicePipelineCommand({ pipeline: operation.pipeline, adminEmail: operation.adminEmail }),
      )
      if (!set.success) {
        switch (set.error) {
          // Another admin saved the same pipeline between our read and write: theirs is the audited change.
          case SetVoicePipelineCommandErrorCode.ALREADY_SET:
            createLogger('voice-settings').info('Voice pipeline already set', {
              pipeline: operation.pipeline,
            })
            return false
          default:
            assertNever(set.error)
        }
      }
      await auditLogManager.execute(
        new RecordAuditLogEntryCommand({
          entryId: randomUUID(),
          adminEmail: operation.adminEmail,
          action: 'VOICE_PIPELINE_CHANGED',
          targetUserId: null,
          targetEmail: null,
          payload: { from: before, to: operation.pipeline },
        }),
      )
      return true
    })
    const { settings } = await voiceSettingsManager.execute(new GetVoicePipelineQuery())
    if (changed)
      createLogger('voice-settings').info('Voice pipeline changed', { pipeline: settings.pipeline })
    return { success: true, changed, settings }
  }
}
