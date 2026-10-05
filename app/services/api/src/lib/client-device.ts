import type { Context } from 'hono'
import { readTracingContext } from '@ryadom/core/shared'

/**
 * What a client says about itself when it opens a session: the system named in `x-client-id` and its
 * `User-Agent`. It is what the person later sees in the list of their sessions, so it is a label
 * and decides nothing.
 */
export interface ClientDevice {
  clientId: string | null
  userAgent: string | null
}

const MAX_USER_AGENT_LENGTH = 300

export function clientDevice(c: Context): ClientDevice {
  // The same reading as the tracing middleware does: a value that is empty, too long or not printable is as good as absent.
  const { systemId } = readTracingContext((name) => c.req.header(name))
  const userAgent = (c.req.header('user-agent') ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, MAX_USER_AGENT_LENGTH)
  return { clientId: systemId ?? null, userAgent: userAgent || null }
}
