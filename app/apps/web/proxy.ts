import { NextResponse, type NextRequest } from 'next/server'
import { readApiBase, toWsBase } from './lib/api-url'

/**
 * Strict CSP with a per-request nonce. The refresh token lives in localStorage, so a script
 * injected into this origin could steal it: scripts must never run without the nonce.
 *
 * style-src keeps the nonce and no 'unsafe-inline'; screens therefore must not render `style=""`
 * attributes on the server (use classes, or CSS variables set from a class). Only `next dev` gets
 * 'unsafe-inline' for styles (without the nonce), because HMR and its error overlay inject inline styles.
 *
 * 'wasm-unsafe-eval' lets the page compile WebAssembly, and nothing else: no `eval`, no strings run as
 * code. The agent's voice needs it where the browser has no Opus decoder of its own (Firefox on Android,
 * Safari before 26): the client then decodes with the WASM build of libopus. Without it such a browser
 * gets μ-law instead, eight times the traffic of Opus.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'
  const api = readApiBase()
  const connect = ["'self'", api, toWsBase(api)].join(' ')

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
    // A nonce makes browsers ignore 'unsafe-inline', so dev drops it: HMR and the error overlay inject <style>.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    `connect-src ${connect}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  // The address of a link to a conversation (`/s/<token>`) is a secret: it must not be cached, and it
  // must not leave in a Referer header. `nextUrl.pathname` has no base path.
  if (request.nextUrl.pathname.startsWith('/s/')) {
    response.headers.set('Referrer-Policy', 'no-referrer')
    response.headers.set('Cache-Control', 'no-store')
  }
  return response
}

export const config = {
  matcher: [
    {
      // The home page. Under a basePath (`/app`) Next puts the prefix in front of every source, so
      // the pattern below becomes `/app/((?!…).*)` and does not match `/app` itself: the home page
      // would be served with no CSP and no nonce, and this app keeps the refresh token in
      // localStorage, which the CSP is what protects. `/` is the one source Next maps to the bare
      // prefix. (The values are literals: Next reads this config statically, no shared constants.)
      source: '/',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
    {
      // The liveness probe is JSON: it needs no nonce and must answer even if this function is broken.
      source: '/((?!api/health|_next/static|_next/image|favicon.svg|voice-worklet.js|sw.js).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
