import type { Page } from '@playwright/test'
import { gunzipSync } from 'node:zlib'

/** One event as the PostHog SDK sent it: the name and the properties (ours and the SDK's own `$` ones). */
export interface SentEvent {
  event: string
  properties: Record<string, unknown>
}

export interface AnalyticsSink {
  /** Every event the SDK has sent so far, in order. */
  all(): SentEvent[]
  /** The properties of the events with this name. */
  named(event: string): Record<string, unknown>[]
}

/** The web app asks the API of another origin; the answers made here have to let it read them. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}

/**
 * Turns product analytics on for this page against a PostHog that is not there: the server's answer about the
 * config is replaced (the stand has no key), and the reverse proxy `/api/ingest` becomes a sink that decodes
 * and keeps what the SDK sends, so that a test can say which events a screen reports and what they carry.
 * Call it before the page is opened: the SDK reads the config once, at startup. The SDK sends in batches every
 * few seconds, so read the sink with `expect.poll`.
 */
export async function captureAnalytics(page: Page): Promise<AnalyticsSink> {
  const sent: SentEvent[] = []
  // The SDK takes a browser driven by a robot (`navigator.webdriver`, the brand "HeadlessChrome") for a bot and drops
  // every event without a word: this page plays a person.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined })
  })
  await page.route(/\/api\/analytics\/config$/, (route) =>
    route.fulfill({
      headers: CORS,
      json: {
        status: true,
        result: {
          enabled: true,
          key: 'phc_e2e_sink',
          uiHost: 'https://eu.posthog.com',
          environment: 'e2e',
          features: {
            sessionReplay: false,
            clickCapture: false,
            heatmapCapture: false,
            errorTracking: false,
            webVitals: false,
            featureFlags: false,
            autocapture: false,
            heatmaps: false,
          },
        },
      },
    }),
  )
  await page.route(/\/api\/ingest\//, async (route) => {
    const method = route.request().method()
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    // The SDK fetches its extension scripts (web vitals, dead clicks) from the same proxy: an empty script is a no-op.
    if (method === 'GET') return route.fulfill({ headers: CORS, contentType: 'application/javascript', body: '' })
    sent.push(...decodeBatch(route.request().postDataBuffer()))
    await route.fulfill({ headers: CORS, json: { status: 1 } })
  })
  return {
    all: () => sent,
    named: (event) => sent.filter((e) => e.event === event).map((e) => e.properties),
  }
}

/** A body of the SDK is a gzip of JSON, or JSON, or `data=<base64 of JSON>`; the JSON is an event or a list of them. */
function decodeBatch(body: Buffer | null): SentEvent[] {
  if (!body || body.length === 0) return []
  try {
    const raw = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body
    let text = raw.toString('utf8')
    if (text.startsWith('data='))
      text = Buffer.from(decodeURIComponent(text.slice(5)), 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : ((parsed as { batch?: unknown[] }).batch ?? [parsed])
    return list.filter(
      (e): e is SentEvent =>
        typeof (e as SentEvent)?.event === 'string' && typeof (e as SentEvent).properties === 'object',
    )
  } catch {
    return []
  }
}

/**
 * What no event of the tests may carry: a score, a level, an answer, or the words typed into the search. The check is
 * on the whole of what was sent, not on a list of events: a new event with a leak is caught as well.
 */
export function leaksOfTests(events: SentEvent[], typedWords: string[]): string[] {
  const leaks: string[] = []
  for (const { event, properties } of events) {
    if (!event.startsWith('self_check_')) continue
    // The SDK's own `$` fields are not ours to judge here (and `$current_url` is scrubbed by the app).
    for (const key of Object.keys(properties).filter((k) => !k.startsWith('$'))) {
      if (/score|band|answer|query|search|text/i.test(key)) leaks.push(`${event}: ключ ${key}`)
    }
    const dump = JSON.stringify(properties).toLowerCase()
    for (const word of typedWords)
      if (dump.includes(word.toLowerCase())) leaks.push(`${event}: слово «${word}»`)
  }
  return leaks
}
