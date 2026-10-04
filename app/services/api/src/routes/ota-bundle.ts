import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError } from '../lib/api-response'
import type { AppEnv, RouteDeps } from '../lib/context'
import { otaBundleFor, otaRoot } from '../lib/ota-bundle'

/**
 * `GET /api/ota/:file` - the archive the JS/OTA axis of `/api/app-status` points to.
 * Baked into the image (`lib/ota-bundle.ts`), so this only ever serves the one file that matches
 * this process's environment; anything else is a 404, same shape as every other API route.
 *
 * Excluded from the version gate (`version-gate.ts`), same as `/api/app-status`: an outdated
 * client must be able to fetch the fix that gets it off the outdated bundle.
 */
export function otaBundleRoutes(app: Hono<AppEnv>, { env }: RouteDeps): void {
  app.get(`${ApiPath.OtaBundle}/:file`, async (c) => {
    const bundle = otaBundleFor(env.APP_ENV)
    const root = otaRoot()
    if (!bundle || !root || c.req.param('file') !== bundle.file) {
      return apiError(c, 404, 'OTA bundle is not available')
    }
    const data = await readFile(join(root, bundle.file))
    c.header('Content-Type', 'application/zip')
    // The file name is stamped with the version, so a stale copy under the same URL never happens.
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
    // Hono wants a plain ArrayBuffer-backed Uint8Array; a Node Buffer is typed more loosely.
    return c.body(new Uint8Array(data))
  })
}
