import { AgentUnavailableError, tracingHeaders } from '../../../shared'
import { agentApiConfig } from '../config'

/**
 * The single way to call the agent: timeout, shared secret in a header, the tracing headers of the
 * current request, JSON parsing.
 *
 * Network errors, timeouts, 5xx and garbage instead of JSON all become `AgentUnavailableError`:
 * technical failures are thrown (core rules), but the application has to tell "the agent is down"
 * apart from its own error so it can answer 503 and show the helplines. Statuses the caller
 * distinguishes (404, 409, 422) arrive in `status`, together with the agent's error code from the
 * body (`{ error: { code, message, details } }`): one status can carry different codes, so the
 * caller decides by the code. A 5xx the caller answers itself (`MEMORY_UNAVAILABLE` is a 503 that
 * means "memory is switched off", not "the agent is down") is named in `handledErrorCodes`.
 */
export interface AgentCallResult<T> {
  status: number
  body: T | null
  /** `error.code` of an error answer; null for a success or an answer without one. */
  errorCode: string | null
  /** `error.details` of that answer as the agent sent it. It may hold anything, so it is never logged. */
  errorDetails: unknown
}

export type AgentMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface AgentCallInit {
  method: AgentMethod
  body?: unknown
  /** Error codes the caller answers itself even under a 5xx status. */
  handledErrorCodes?: readonly string[]
}

function agentErrorOf(body: unknown): { code: string | null; details: unknown } {
  if (typeof body !== 'object' || body === null) return { code: null, details: null }
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return { code: null, details: null }
  const { code, details } = error as { code?: unknown; details?: unknown }
  return { code: typeof code === 'string' && code ? code : null, details: details ?? null }
}

export async function callAgent<T>(
  path: string,
  init: AgentCallInit = { method: 'GET' },
): Promise<AgentCallResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...tracingHeaders() }
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

  if (response.status === 204) {
    return { status: response.status, body: null, errorCode: null, errorDetails: null }
  }

  const text = await response.text().catch(() => '')
  let body: T | null = null
  let malformed: unknown = null
  if (text) {
    try {
      body = JSON.parse(text) as T
    } catch (error) {
      malformed = error
    }
  }
  const { code, details } = agentErrorOf(body)

  if (response.status >= 500) {
    if (code !== null && init.handledErrorCodes?.includes(code)) {
      return { status: response.status, body, errorCode: code, errorDetails: details }
    }
    throw new AgentUnavailableError(
      `Agent API responded ${response.status}${code ? ` ${code}` : ''} for ${init.method} ${path}`,
    )
  }
  if (malformed !== null) {
    throw new AgentUnavailableError(`Agent API returned malformed JSON for ${init.method} ${path}`, malformed)
  }
  return { status: response.status, body, errorCode: code, errorDetails: details }
}

/** Path to a user's dialogs: the agent itself checks that the dialog belongs to this person. */
export function userDialogsPath(userId: string): string {
  return `/v1/users/${encodeURIComponent(userId)}/dialogs`
}

/** Path to a user's memory: everything under it belongs to that person, the agent checks the rest. */
export function userMemoryPath(userId: string): string {
  return `/v1/users/${encodeURIComponent(userId)}/memory`
}
