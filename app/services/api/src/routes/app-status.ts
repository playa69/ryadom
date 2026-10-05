import type { Hono } from 'hono'
import { z } from 'zod'
import { AppPlatform } from '@ryadom/contracts/api/headers'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiOk } from '../lib/api-response'
import type { AppEnv, RouteDeps } from '../lib/context'
import { isVersionString, parseVersionCode, resolveAppStatus } from '../lib/release-policy'
import { queryParams } from '../lib/request'

/**
 * `GET /api/app-status` — the version policy: native axis from env, JS/OTA axis baked
 * into the image. Open to any version: this is where an outdated client comes for instructions
 * after a 426.
 */
const querySchema = z.object({
  platform: z.enum(AppPlatform),
  version_code: z.string().refine((value) => parseVersionCode(value) !== null, 'must be a versionCode'),
  js_version: z.string().refine(isVersionString, 'must be a version like 1.2.3').optional(),
})

export function appStatusRoutes(app: Hono<AppEnv>, { env, policy }: RouteDeps): void {
  app.get(ApiPath.AppStatus, queryParams(querySchema), (c) => {
    const { platform, version_code, js_version } = c.req.valid('query')
    const storeUrl =
      (platform === AppPlatform.Ios ? env.MOBILE_IOS_STORE_URL : env.MOBILE_ANDROID_STORE_URL) ?? null
    return apiOk(
      c,
      resolveAppStatus(
        policy.get(),
        { platform, versionCode: parseVersionCode(version_code) ?? 0, jsVersion: js_version ?? null },
        storeUrl,
      ),
    )
  })
}
