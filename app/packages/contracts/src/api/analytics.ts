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
   * Legal risk (Russia), HIGH: a recording of behaviour on screen; even masked it may show the person's
   * state (152-FZ art. 10, written consent). Only with a separate consent and an updated policy.
   */
  sessionReplay: boolean
  /**
   * Clicks and dead clicks as the structure of the page (which element, where in the markup), never
   * the text or the attributes of the element: the client strips them before anything is sent.
   * Legal risk (Russia), MEDIUM: events tied to the account id describe behaviour in detail (art. 5
   * parts 1-2); if the scrubbing ever lets text through it is page content or data about the person
   * (art. 10). Crisis paths and screens with content carry `ph-no-capture`.
   */
  clickCapture: boolean
  /**
   * Heatmaps: where on a screen people tap. Coordinates and the route, no text. Keep OFF for now.
   * Legal risk (Russia), MEDIUM until reworked: the SDK knows nothing of `ph-no-capture`, so a tap on SOS
   * or a hotline becomes a point under the account id and defeats the anonymous crisis counting; the
   * event also takes the same cross-border path as every other (art. 12, art. 18 part 5).
   */
  heatmapCapture: boolean
  /**
   * Unhandled errors and rejections of the client, reported as exceptions.
   * Legal risk (Russia), LOW-MEDIUM: an error's text and stack could hold page data (art. 5 part 5); the
   * client makes the text impersonal and scrubs the frames' addresses.
   */
  errorTracking: boolean
  /**
   * Core Web Vitals and page load timings.
   * Legal risk (Russia), LOW: timings and device data; attribution is off.
   */
  webVitals: boolean
  /**
   * Feature flags evaluated for the person.
   * Legal risk (Russia), LOW-MEDIUM: every launch sends the recipient the account id and `account_kind`,
   * a transfer even without events; not requested after the person opts out.
   */
  featureFlags: boolean
  /**
   * Read by clients shipped before the capabilities above existed (their `autocapture` and `heatmaps`
   * could not strip element text and page addresses). The server
   * sends `false` always, so a switch flipped in the ConfigMap never turns those on in an old client.
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
   * `APP_ENV` of the server. The staging and prod stacks share one PostHog project, so every event
   * carries this and the dashboards filter on it.
   */
  environment: string
  features: AnalyticsFeatures
}
