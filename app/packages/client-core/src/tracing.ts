import { TracingHeader } from '@ryadom/contracts/api/headers'

/**
 * Tracing headers for the requests of one client. A request starts in the app, so the trace id is
 * made here: the API and the agent only pass it on, and without it their logs could not be lined up.
 * `x-user-id` is not sent: the API takes the account from the token, which a header cannot forge.
 */
export function createTracing(clientId: string | undefined): () => Record<string, string> {
  // One value for the life of the client (a page load, an app launch): the logs of a whole visit
  // line up by it.
  const sessionId = randomUuid()

  return () => {
    const headers: Record<string, string> = { [TracingHeader.RequestTime]: new Date().toISOString() }
    const traceId = randomUuid()
    if (traceId) headers[TracingHeader.TraceId] = traceId
    if (clientId) headers[TracingHeader.ClientId] = clientId
    if (sessionId) headers[TracingHeader.SessionId] = sessionId
    return headers
  }
}

/** `crypto.randomUUID` exists only in secure contexts; where it is missing the header is left out, not faked. */
function randomUuid(): string | undefined {
  return globalThis.crypto?.randomUUID?.()
}
