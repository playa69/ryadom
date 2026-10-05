import 'server-only'

/**
 * The site has no database, no core package and no secrets: it is a public page whose
 * compromise cannot reach user data. Everything here is a public address.
 *
 * Read per request, not at build time, so one image serves every environment.
 */
export interface WebEnv {
  /** The signed-in web app (apps/web): where "open the app" leads. */
  appUrl: string
  /** The PWA, always with a trailing slash (it is the scope). Null: the install block is not shown. */
  pwaUrl: string | null
  androidApkUrl: string | null
  rustoreUrl: string | null
  googlePlayUrl: string | null
  appStoreUrl: string | null
  supportEmail: string
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replace(/\/+$/, '') : null
}

export function getWebEnv(): WebEnv {
  const pwaUrl = optional(process.env.PUBLIC_PWA_URL)
  return {
    // Where the "open the app" links lead: the signed-in web app. On a host shared with the other
    // apps that is a path (`https://example.com/app/`), so this is its own address and not the origin
    // of the API (PUBLIC_APP_URL), which serves no client.
    appUrl: optional(process.env.PUBLIC_WEBAPP_URL) ?? 'http://localhost:3003',
    // The PWA is a separate app on the same host (`https://example.com/pwa/`). The download page links
    // it with install instructions; without the address it simply is not offered.
    pwaUrl: pwaUrl ? `${pwaUrl}/` : null,
    androidApkUrl: optional(process.env.PUBLIC_ANDROID_APK_URL),
    rustoreUrl: optional(process.env.PUBLIC_RUSTORE_URL),
    googlePlayUrl: optional(process.env.PUBLIC_GOOGLE_PLAY_URL),
    appStoreUrl: optional(process.env.PUBLIC_APP_STORE_URL),
    supportEmail: process.env.PUBLIC_SUPPORT_EMAIL?.trim() || 'support@ryadom.app',
  }
}
