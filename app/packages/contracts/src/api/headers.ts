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

/**
 * Tracing headers: the same five that `agent/` takes and passes on
 * (`.agents/skills/api-headers-rules`). The app sends them on every request, the API puts them in
 * its log records and forwards them to the agent. Lower case, as they travel on the wire.
 */
export enum TracingHeader {
  /** Id of one request, the same in the logs of every service it passes through (`rqUId`). */
  TraceId = 'x-trace-id',
  /** When the caller sent the request, ISO 8601 (`rqTime`). */
  RequestTime = 'x-request-time',
  /** Which system is calling: the web app, the Android build (`systemId`). */
  ClientId = 'x-client-id',
  /** Session of the caller (`gwSessionId`). */
  SessionId = 'x-session-id',
  /** Who is calling. Behind a token the API replaces the client's value with the verified account (`userId`). */
  UserId = 'x-user-id',
}
