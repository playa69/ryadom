import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { agentApiIntegration, GetAgentMemoryRequest } from '../../../integrations/agent-api'
import { AgentUnavailableError } from '../../../shared'
import { userZone } from '../shared/user-zone'
import { GetDiaryEventsOperation } from './get-diary-events.operation'
import { GetDiaryEventsOperationErrorCode, type GetDiaryEventsResult } from './get-diary-events.types'

@requestHandler(GetDiaryEventsOperation)
export class GetDiaryEventsOperationHandler implements RequestHandler<GetDiaryEventsOperation, GetDiaryEventsResult> {
  async handle(c: GetDiaryEventsOperation): Promise<GetDiaryEventsResult> {
    if (!(await userZone(c.userId))) return { success: false, error: GetDiaryEventsOperationErrorCode.USER_NOT_FOUND }
    // The notes themselves come from the agent's memory (`add-memory-notes`, PROTEUS-242); until it
    // serves them the block shows the empty state, or «memory is off» when the person turned it off.
    let memoryEnabled = true
    try {
      const memory = await agentApiIntegration.execute(new GetAgentMemoryRequest({ userId: c.userId }))
      memoryEnabled = memory.enabled
    } catch (error) {
      if (!(error instanceof AgentUnavailableError)) throw error
    }
    return { success: true, memoryEnabled, events: [] }
  }
}
