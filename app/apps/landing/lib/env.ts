import 'server-only'

/**
 * The site has no database, no core package and no secrets: it is a public page whose
 * compromise cannot reach user data. Everything here is a public address.
 *
 * Read per request, not at build time, so one image serves every environment.
 */
export interface WebEnv {
  appUrl: string
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
  return {
    appUrl: optional(process.env.PUBLIC_APP_URL) ?? 'http://localhost:3002',
    androidApkUrl: optional(process.env.PUBLIC_ANDROID_APK_URL),
    rustoreUrl: optional(process.env.PUBLIC_RUSTORE_URL),
    googlePlayUrl: optional(process.env.PUBLIC_GOOGLE_PLAY_URL),
    appStoreUrl: optional(process.env.PUBLIC_APP_STORE_URL),
    supportEmail: process.env.PUBLIC_SUPPORT_EMAIL?.trim() || 'support@ryadom.app',
  }
}
