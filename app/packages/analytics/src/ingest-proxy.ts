/**
 * A reverse proxy to PostHog, written against the Fetch API so it runs in Hono, Next route handlers
 * or a test with no framework around it.
 *
 * Why the clients talk to us and not to PostHog:
 * - ad blockers and corporate filters drop requests to `*.posthog.com`, ours look like the app's own;
 * - one `connect-src` origin in the content-security policies instead of three third-party hosts;
 * - the person's IP address, cookies and headers never reach a third party, because this is where they stop.
 *
 * What it forwards is a closed list of the SDK's own endpoints. It is not a general proxy: an unknown
 * path is a 404, so it cannot be pointed at anything else PostHog (or its CDN) serves.
 */

export interface IngestProxyOptions {
  /** Where events and flag requests go, e.g. `https://eu.i.posthog.com`. */
  ingestHost: string
  /** Where the SDK's lazy-loaded scripts live, e.g. `https://eu-assets.i.posthog.com`. */
  assetsHost: string
  /** The mount point, e.g. `/api/ingest`: what comes before the SDK's own path. */
  basePath: string
  /** The largest request body accepted. A session-recording chunk is the big one. */
  maxBodyBytes?: number
  /** How long to wait for PostHog before answering 502. */
  timeoutMs?: number
  /**
   * Pass the caller's address on in `X-Forwarded-For`, so PostHog can place the person on a map.
   * Off: PostHog sees our address and the request carries `ip=0`. Off is the default for a reason:
   * an address is personal data, and the product is a place people come to when they are not well.
   */
  forwardClientIp?: boolean
  /** The caller's address, needed only with `forwardClientIp`. */
  clientIp?: (request: Request) => string | undefined
  /** For tests. */
  fetch?: typeof fetch
}

export type IngestProxy = (request: Request) => Promise<Response>

/** Paths served by the ingest host. `/e` is the classic capture endpoint, `/i/v0/e` the current one. */
const INGEST_PREFIXES = ['/e', '/i/v0/e', '/batch', '/capture', '/s', '/flags', '/decide', '/engage', '/ses']
/**
 * Read-only paths on the ingest host: the list of surveys for a project token. The SDK asks for
 * `${api_host}/api/surveys/?token=…` once surveys are on, and without this the switch would do nothing.
 * Nothing else under `/api/` is served: that is PostHog's management API.
 */
const READ_PREFIXES = ['/api/surveys']
/** Paths served by the assets host: the SDK's extension scripts and its remote config. */
const ASSET_PREFIXES = ['/static', '/array']

const DEFAULT_MAX_BODY = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

/** Request headers that mean something to PostHog. Everything else (cookies, authorization) stops here. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'content-encoding', 'accept', 'accept-language', 'user-agent']

/** Response headers worth keeping. Encoding and length are recomputed, because the body is re-read. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'expires', 'vary']

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** Resolves the SDK's path (the part after `basePath`) to a target host, or null for a path we do not serve. */
export function routeIngestPath(
  path: string,
  method: string,
): { target: 'ingest' | 'assets'; path: string } | null {
  const normalized = path.replace(/\/{2,}/g, '/')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) return null
  if (ASSET_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix))) {
    // Scripts and config are read, never written.
    return method === 'GET' || method === 'HEAD' ? { target: 'assets', path: normalized } : null
  }
  if (READ_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix))) {
    return method === 'GET' || method === 'HEAD' ? { target: 'ingest', path: normalized } : null
  }
  if (INGEST_PREFIXES.some((prefix) => matchesPrefix(normalized, prefix))) {
    return { target: 'ingest', path: normalized }
  }
  return null
}

/** Reads a body up to a limit; null means it was larger. */
async function readBody(request: Request, limit: number): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  if (!request.body) return new ArrayBuffer(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export function createIngestProxy(options: IngestProxyOptions): IngestProxy {
  const basePath = options.basePath.replace(/\/+$/, '')
  const ingestHost = options.ingestHost.replace(/\/+$/, '')
  const assetsHost = options.assetsHost.replace(/\/+$/, '')
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // The global is read when a request arrives, not when the proxy is built, so a test can stub it later.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init))

  return async (request) => {
    const incoming = new URL(request.url)
    if (!matchesPrefix(incoming.pathname, basePath)) return plain(404, 'Not found')

    const method = request.method.toUpperCase()
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') return plain(405, 'Method not allowed')

    const routed = routeIngestPath(incoming.pathname.slice(basePath.length) || '/', method)
    if (!routed) return plain(404, 'Not found')

    const upstream = new URL(`${routed.target === 'assets' ? assetsHost : ingestHost}${routed.path}`)
    upstream.search = incoming.search
    if (routed.target === 'ingest' && !options.forwardClientIp) upstream.searchParams.set('ip', '0')

    const headers = new Headers()
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (options.forwardClientIp) {
      const ip = options.clientIp?.(request)
      if (ip) headers.set('x-forwarded-for', ip)
    }

    let body: ArrayBuffer | undefined
    if (method === 'POST') {
      const read = await readBody(request, maxBody)
      if (read === null) return plain(413, 'Payload too large')
      body = read
    }

    let response: Response
    try {
      response = await doFetch(upstream, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // The SDK retries with backoff, and analytics must never be the reason anything else fails.
      return plain(502, 'Upstream unavailable')
    }

    const out = new Headers()
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (value) out.set(name, value)
    }
    // Redirects from PostHog would send the browser to a third-party host; there are none to follow.
    if (response.status >= 300 && response.status < 400) return plain(502, 'Upstream redirected')
    return new Response(method === 'HEAD' ? null : response.body, { status: response.status, headers: out })
  }
}
