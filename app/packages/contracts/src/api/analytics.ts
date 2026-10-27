/**
 * Product analytics: what a client has to know before it starts reporting.
 *
 * `GET /api/analytics/config` is open and carries no personal data. The clients (web, the PWA, the
 * store builds, the landing) read it once at startup and only then load the PostHog SDK, so analytics
 * are switched off on the server (an empty `POSTHOG_KEY`) without a rebuild of the clients or an OTA
 * bundle. What a client collects once analytics are on is fixed in its code (`buildSdkConfig`).
 *
 * Events never go to PostHog directly. The SDK is pointed at `/api/ingest` (`ApiPath.Ingest`), our own
 * reverse proxy in services/api: ad blockers and regional blocks do not see a third-party host, and
 * the content-security policies of the clients keep a single `connect-src` origin.
 *
 * The files in src/api end up in the client bundles, so this one holds only types.
 */

/**
 * Kept for older clients: builds shipped before the PostHog capabilities were fixed in client code read
 * here what to turn on. The current clients ignore it. The values are the ones the current clients have
 * built in, so an old client collects the same and nothing more.
 */
export interface AnalyticsFeatures {
  sessionReplay: false
  clickCapture: true
  heatmapCapture: false
  errorTracking: true
  webVitals: true
  featureFlags: false
  /**
   * Read by clients older still, whose `autocapture` and `heatmaps` could not strip element text and page
   * addresses: `false` keeps those off.
   */
  autocapture: false
  heatmaps: false
}

export interface AnalyticsConfigApiResponse {
  /** false: the client sends nothing and loads nothing. `key` is then null. */
  enabled: boolean
  /**
   * The PostHog project token. It is public by design (it can only write events, never read them),
   * which is why an open endpoint may hand it out.
   */
  key: string | null
  /** The PostHog web app, used by the SDK for links such as the toolbar. */
  uiHost: string
  /**
   * `APP_ENV` of the server. Every event carries it as `app_env`, so a local run with a key never mixes
   * with prod in the dashboards.
   */
  environment: string
  /** Kept for older clients (see `AnalyticsFeatures`). */
  features: AnalyticsFeatures
}
