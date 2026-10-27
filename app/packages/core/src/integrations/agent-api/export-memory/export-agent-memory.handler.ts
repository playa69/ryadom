import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { parseAgentMemoryExport } from '../shared/agent-memory.parse'
import { callAgent, userMemoryPath } from '../shared/request'
import { ExportAgentMemoryRequest } from './export-agent-memory.request'
import type { ExportAgentMemoryResponse } from './export-agent-memory.types'

/** `GET /v1/users/{userId}/memory/export`: works with the person's memory off. */
@requestHandler(ExportAgentMemoryRequest)
export class ExportAgentMemoryRequestHandler implements RequestHandler<
  ExportAgentMemoryRequest,
  ExportAgentMemoryResponse
> {
  async handle(request: ExportAgentMemoryRequest): Promise<ExportAgentMemoryResponse> {
    const { status, body, errorCode } = await callAgent<unknown>(`${userMemoryPath(request.userId)}/export`)
    if (status !== 200)
      throw new Error(`Agent API refused to export memory: ${status} ${errorCode ?? ''}`.trim())
    return parseAgentMemoryExport(body)
  }
}
