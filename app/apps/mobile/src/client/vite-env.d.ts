/// <reference types="vite/client" />

/**
 * Client build variables (the contract with CI, see vite.config.ts). They are inlined as literals:
 * the minifier folds checks like `import.meta.env.VITE_FLAVOR === 'dev'` into a constant and drops
 * the unreachable code, which is what keeps the env switcher out of production.
 */
interface ImportMetaEnv {
  readonly VITE_FLAVOR?: string
  readonly VITE_PROD_API_URL?: string
  readonly VITE_PROD_WEB_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Version from apps/mobile/package.json, also the build versionName and the OTA bundle version. */
declare const __APP_VERSION__: string

/** What analytics report as `app_version`: the build's release tag (`RELEASE`), else the package version. */
declare const __RELEASE__: string
