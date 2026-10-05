/**
 * The prefix the admin is published under (`/admin`), empty on a host of its own. Set at build time
 * from `BASE_PATH` (next.config.ts).
 *
 * Next adds it by itself to `<Link>`, `redirect()` in pages and server actions, `router.push` and
 * the asset URLs. It does NOT add it to what Next never sees as a route:
 * - the `action` of a plain HTML `<form>`,
 * - a `redirect()` inside a route handler (the `Location` header is sent as written),
 * - string URLs in metadata (favicon),
 * - the `path` of a cookie.
 * Those places use this constant.
 */
export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

/** A root-absolute path of this app with the prefix in front: `appPath('/login')` is `/admin/login`. */
export function appPath(path: string): string {
  return `${BASE_PATH}${path}`
}
