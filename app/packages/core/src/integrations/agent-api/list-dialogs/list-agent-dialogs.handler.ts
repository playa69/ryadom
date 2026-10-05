import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent, userDialogsPath } from '../shared/request'
import { ListAgentDialogsRequest } from './list-agent-dialogs.request'
import type { ListAgentDialogsResponse } from './list-agent-dialogs.types'

/** `GET /v1/users/{userId}/dialogs`: the journal, summaries of past conversations without messages. */
@requestHandler(ListAgentDialogsRequest)
export class ListAgentDialogsRequestHandler
  implements RequestHandler<ListAgentDialogsRequest, ListAgentDialogsResponse>
{
  async handle(request: ListAgentDialogsRequest): Promise<ListAgentDialogsResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) })
    if (request.before) params.set('before', request.before)
    const { status, body } = await callAgent<ListAgentDialogsResponse>(
      `${userDialogsPath(request.userId)}?${params.toString()}`,
    )
    if (status !== 200) throw new Error(`Agent API refused to list dialogs: ${status}`)
    return { items: Array.isArray(body?.items) ? body.items : [], next: body?.next ?? null }
  }
}
