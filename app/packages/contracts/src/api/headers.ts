/**
 * Headers the app sends on every request, plus values shared by the client and the
 * server.
 */

export enum AppHeader {
  /** `Bearer <access JWT>`. */
  Authorization = 'Authorization',
  /**
   * Platform of a store build: `android` or `ios`. The web build does not send this header, because
   * it is always the same version as the API and needs no version gate.
   */
  Platform = 'X-Platform',
  /** The Android build's versionCode or the iOS build number. */
  AppVersion = 'X-App-Version',
  /** OTA bundle version (`version` from package.json at the time the bundle was built). */
  JsVersion = 'X-Js-Version',
}

export enum AppPlatform {
  Android = 'android',
  Ios = 'ios',
}
