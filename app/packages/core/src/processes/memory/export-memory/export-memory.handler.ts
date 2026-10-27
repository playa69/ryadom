import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { createLogger } from '../../../shared'
import { agentApiIntegration, ExportAgentMemoryRequest } from '../../../integrations/agent-api'
import { isLiveUser } from '../shared/ensure-live-user'
import { toMemoryExportDTO } from '../shared/memory.dto'
import { ExportMemoryOperation } from './export-memory.operation'
import { ExportMemoryOperationErrorCode, type ExportMemoryResult } from './export-memory.types'

/** "Download my memory": everything, guesses and proposed facts included. Works with memory switched off. */
@requestHandler(ExportMemoryOperation)
export class ExportMemoryOperationHandler implements RequestHandler<
  ExportMemoryOperation,
  ExportMemoryResult
> {
  async handle(operation: ExportMemoryOperation): Promise<ExportMemoryResult> {
    if (!(await isLiveUser(operation.userId))) {
      return { success: false, error: ExportMemoryOperationErrorCode.USER_NOT_FOUND }
    }
    const exported = await agentApiIntegration.execute(
      new ExportAgentMemoryRequest({ userId: operation.userId }),
    )
    createLogger('memory').info('Memory exported', {
      userId: operation.userId,
      factCount: exported.facts.length,
    })
    return { success: true, export: toMemoryExportDTO(exported) }
  }
}
