import { App } from '@capacitor/app'
import { isNative } from './platform'

/** Build version the app reports to the version gate (app-update.ts). */
export interface VersionInfo {
  /** versionName, e.g. `0.1.0`. */
  versionName: string
  /** Android/iOS build number; absent in a browser. */
  versionCode: number | null
}

let versionInfo: Promise<VersionInfo> | null = null

export function getVersionInfo(): Promise<VersionInfo> {
  if (!versionInfo) {
    versionInfo = (async () => {
      if (!isNative()) return { versionName: __APP_VERSION__, versionCode: null }
      try {
        const info = await App.getInfo()
        const code = Number.parseInt(info.build, 10)
        return { versionName: info.version || __APP_VERSION__, versionCode: Number.isFinite(code) ? code : null }
      } catch {
        return { versionName: __APP_VERSION__, versionCode: null }
      }
    })()
  }
  return versionInfo
}
