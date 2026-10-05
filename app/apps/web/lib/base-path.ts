/**
 * The prefix the web client is published under (`/app`), empty on a host of its own. Set at build
 * time from `BASE_PATH` (next.config.ts).
 *
 * Next adds it by itself to `<Link>`, `router.push/replace`, `redirect()` and the asset URLs
 * (`/_next/static`, `public/`). It does NOT add it to URLs that are plain strings the browser
 * resolves on its own: the favicon in the metadata, the audio worklet module. Those use this.
 */
export const BASE_PATH: string = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

/** A root-absolute path of this app with the prefix in front: `appPath('/x.js')` is `/app/x.js`. */
export function appPath(path: string): string {
  return `${BASE_PATH}${path}`
}
