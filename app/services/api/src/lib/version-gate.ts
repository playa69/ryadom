import type { MiddlewareHandler } from 'hono'
import { AppHeader, AppPlatform } from '@ryadom/contracts/api/headers'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError } from './api-response'
import type { AppEnv } from './context'
import { isClientAllowed, parseJsVersion, parseVersionCode, type PolicySource } from './release-policy'

/**
 * Version gate. A store build sends `X-Platform` and its versions on every
 * request; below the minimum it gets 426 and goes to `/api/app-status` for instructions.
 *
 * Requests without those headers (the web clients, the PWA, a browser on the dev server, monitoring)
 * are not checked: a web client is not an installed build that can fall behind the minimum, it is
 * whatever the host serves. The PWA is its own image, so it is deployed independently of the API
 * and the API has to stay compatible with the previous PWA build for a while. `/api/app-status` and
 * `/api/health` are always open, otherwise an outdated client would loop; `/api/ota/*` is open too,
 * otherwise a client below the minimum could never reach the very bundle that would get it off that
 * version.
 */
const OPEN_PATHS = new Set<string>([ApiPath.AppStatus, ApiPath.Health, '/metrics'])
const OPEN_PREFIXES = [`${ApiPath.OtaBundle}/`]

function platformOf(raw: string | undefined): AppPlatform | null {
  if (raw === AppPlatform.Android) return AppPlatform.Android
  if (raw === AppPlatform.Ios) return AppPlatform.Ios
  return null
}

export function versionGate(policySource: PolicySource): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      c.req.method === 'OPTIONS' ||
      OPEN_PATHS.has(c.req.path) ||
      OPEN_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
    ) {
      return next()
    }

    const platform = platformOf(c.req.header(AppHeader.Platform))
    const version = c.req.header(AppHeader.AppVersion)
    if (platform === null || version === undefined) return next()

    // An unusable versionCode counts as zero: such a client is certainly outdated.
    const allowed = isClientAllowed(policySource.get(), {
      platform,
      versionCode: parseVersionCode(version) ?? 0,
      jsVersion: parseJsVersion(c.req.header(AppHeader.JsVersion)),
    })
    if (!allowed) return apiError(c, 426, 'App version is no longer supported: see /api/app-status')
    return next()
  }
}
