import { AgentUnavailableError } from '../../../shared'
import { agentApiConfig } from '../config'

/**
 * The single way to call the agent: timeout, shared secret in a header, JSON parsing.
 *
 * Network errors, timeouts, 5xx and garbage instead of JSON all become `AgentUnavailableError`:
 * technical failures are thrown (core rules), but the application has to tell "the agent is down"
 * apart from its own error so it can answer 503 and show the helplines. Statuses the caller
 * distinguishes (404) arrive in `status`.
 */
export interface AgentCallResult<T> {
  status: number
  body: T | null
}

export async function callAgent<T>(
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown } = { method: 'GET' },
): Promise<AgentCallResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const token = agentApiConfig.token
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${agentApiConfig.baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(agentApiConfig.timeoutMs),
    })
  } catch (error) {
    throw new AgentUnavailableError(`Agent API did not answer ${init.method} ${path}`, error)
  }

  if (response.status >= 500) {
    throw new AgentUnavailableError(`Agent API responded ${response.status} for ${init.method} ${path}`)
  }
  if (response.status === 204) return { status: response.status, body: null }

  const text = await response.text().catch(() => '')
  if (!text) return { status: response.status, body: null }
  try {
    return { status: response.status, body: JSON.parse(text) as T }
  } catch (error) {
    throw new AgentUnavailableError(`Agent API returned malformed JSON for ${init.method} ${path}`, error)
  }
}

/** Path to a user's dialogs: the agent itself checks that the dialog belongs to this person. */
export function userDialogsPath(userId: string): string {
  return `/v1/users/${encodeURIComponent(userId)}/dialogs`
}
