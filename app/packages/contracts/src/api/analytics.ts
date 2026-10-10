/**
 * Product analytics: what a client has to know before it starts reporting.
 *
 * `GET /api/analytics/config` is open and carries no personal data. The clients (web, the PWA, the
 * store builds, the landing) read it once at startup and only then load the PostHog SDK, so the
 * switches below are flipped in the server's ConfigMap and need neither a rebuild of the clients nor
 * an OTA bundle.
 *
 * Events never go to PostHog directly. The SDK is pointed at `/api/ingest` (`ApiPath.Ingest`), our own
 * reverse proxy in services/api: ad blockers and regional blocks do not see a third-party host, and
 * the content-security policies of the clients keep a single `connect-src` origin.
 *
 * The files in src/api end up in the client bundles, so this one holds only types.
 */

/** Optional PostHog capabilities. Each can be switched off on the server on its own. */
export interface AnalyticsFeatures {
  /**
   * Session replay. Off unless the server turns it on, and when it is on every input and every piece
   * of text is masked: a replay shows the layout and the taps, never the conversation.
   */
  sessionReplay: boolean
  /** PostHog surveys (NPS and the like) shown as a pop-up inside the app. */
  surveys: boolean
  /** Click autocapture. It records the text of the clicked element, so it is off by default. */
  autocapture: boolean
  /** Heatmaps: where on a screen people tap. Coordinates and element selectors, no text; off by default. */
  heatmaps: boolean
  /** Unhandled errors and rejections of the client, reported as exceptions. */
  errorTracking: boolean
  /** Core Web Vitals and page load timings. */
  webVitals: boolean
  /** Feature flags evaluated for the person. */
  featureFlags: boolean
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
   * `APP_ENV` of the server. The staging and prod stacks share one PostHog project, so every event
   * carries this and the dashboards filter on it.
   */
  environment: string
  features: AnalyticsFeatures
}
