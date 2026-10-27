import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent } from '../shared/request'
import { ListAgentRecapsRequest } from './list-agent-recaps.request'
import type { ListAgentRecapsResult } from './list-agent-recaps.types'

@requestHandler(ListAgentRecapsRequest)
export class ListAgentRecapsRequestHandler implements RequestHandler<ListAgentRecapsRequest, ListAgentRecapsResult> {
  async handle(request: ListAgentRecapsRequest): Promise<ListAgentRecapsResult> {
    const params = new URLSearchParams({ limit: String(request.limit) })
    if (request.before) params.set('before', request.before)
    const { status, body } = await callAgent<ListAgentRecapsResult>(
      `/v1/users/${encodeURIComponent(request.userId)}/recaps?${params.toString()}`,
    )
    if (status !== 200) throw new Error(`Agent API refused to list recaps: ${status}`)
    return { items: Array.isArray(body?.items) ? body.items : [], next: body?.next ?? null }
  }
}
