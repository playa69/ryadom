import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'
import { PwaMeta } from '@ryadom/contracts/pwa'
import { apiError } from './api-response'
import type { AppDeps, AppEnv } from './context'

/**
 * Serving the client web build: the same process that answers `/api/*` also
 * serves the PWA. There is no separate service, so the client and the API are always the same
 * version because they ship in one image.
 *
 * Registered last in app.ts, after every `/api/*` route, because those never call `next()` and
 * only requests without an exact route reach here. If the build directory is missing
 * (`pnpm build:pwa` was never run) nothing is registered and `/api/*` behaves as before.
 */

function resolvePwaRoot(): string | null {
  // The container (the Dockerfile puts the build next to the server bundle) and a local
  // `pnpm dev:api` (cwd is services/api; the PWA is copied into dist/pwa there) have different working directories.
  for (const candidate of [join(process.cwd(), 'pwa'), join(process.cwd(), 'dist', 'pwa')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return null
}

const NO_CACHE_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js'])

function cacheControlFor(diskPath: string): string {
  const filename = diskPath.split(/[/\\]/).pop() ?? ''
  // Vite stamps JS, CSS and fonts with a hash in the filename, so an old version of a file is
  // never served under the same URL and such files can be cached forever.
  return NO_CACHE_FILES.has(filename) ? 'no-cache' : 'public, max-age=31536000, immutable'
}

/**
 * `connect-src` includes `ws:` and `wss:` because a dialog runs over WebSocket to the same origin.
 * `media-src blob:` is for playing back speech. Framing the app is denied to everyone.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * One image serves both staging and prod, so the site address and the environment are not baked
 * into the build: the server injects meta tags before `</head>` on every `index.html` response.
 */
function injectMeta(html: string, env: AppDeps['env']): string {
  const meta =
    `<meta name="${PwaMeta.WebUrl}" content="${escapeHtmlAttribute(env.PUBLIC_WEB_URL)}">` +
    `<meta name="${PwaMeta.AppEnv}" content="${escapeHtmlAttribute(env.APP_ENV)}">`
  return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : html
}

/**
 * `root` is only for tests: it substitutes a fixture instead of looking on disk.
 *
 * `PWA_BASE_PATH` (`/pwa`, or empty) is where the PWA sits on the host. With a prefix the build has
 * it in every URL (Vite `base`), so the server only has to answer under it: the files are looked up
 * with the prefix removed, the SPA fallback is served only under it, `/pwa` leads to `/pwa/` and the
 * root of the host leads to the app. Everything else outside `/api/*` is a 404 in the API's own
 * format, never HTML. Without a prefix the PWA owns every path that is not `/api/*`.
 */
export function registerPwaServing(app: Hono<AppEnv>, deps: AppDeps, root = resolvePwaRoot()): void {
  if (!root) return

  const base = deps.env.PWA_BASE_PATH
  const entry = `${base}/`
  const underBase = (path: string): boolean =>
    base === '' ? !path.startsWith('/api/') : path === base || path.startsWith(entry)

  if (base !== '') {
    const withSearch = (url: string, target: string): string => `${target}${new URL(url).search}`
    app.get(base, (c) => c.redirect(withSearch(c.req.url, entry), 301))
    app.get('/', (c) => c.redirect(withSearch(c.req.url, entry), 302))
  }

  app.use('*', async (c, next) => {
    if (!underBase(c.req.path)) return next()
    // index.html goes only through the catch-all below: serveStatic finds it for "/" by itself and
    // would serve it as is, without the injected meta tags.
    if (c.req.path === entry || c.req.path === `${entry}index.html`) return next()
    return serveStatic({
      root,
      rewriteRequestPath: base === '' ? undefined : (path) => path.slice(base.length),
      onFound: (diskPath, ctx) => {
        ctx.header('Cache-Control', cacheControlFor(diskPath))
        ctx.header('X-Robots-Tag', 'noindex')
        ctx.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      },
    })(c, next)
  })

  // An SPA route with no file on disk (for example /dialog/d-1/) gets index.html; the client
  // (Framework7) resolves the route itself. `/api/*` never reaches here, or it would get HTML.
  app.get('*', async (c) => {
    if (!underBase(c.req.path)) return apiError(c, 404, `No route for GET ${c.req.path}`)
    const html = await readFile(join(root, 'index.html'), 'utf8').catch(() => null)
    if (html === null) return apiError(c, 404, 'PWA build is missing index.html')
    c.header('Content-Type', 'text/html; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    c.header('X-Robots-Tag', 'noindex')
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    return c.body(injectMeta(html, deps.env))
  })
}
