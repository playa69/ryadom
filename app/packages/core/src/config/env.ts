import { z } from 'zod'

/**
 * Server environment variables. An empty string counts as "not set": env files
 * often use `KEY=` for a disabled feature.
 */
const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const optionalString = z.preprocess(emptyToUndefined, z.string().optional())

const publicUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .transform((value) => value.replace(/\/+$/, ''))

/**
 * An address that is an origin: scheme, host and port, no path. The API lives at `<origin>/api/...`
 * and the OTA bundle URLs are `<origin>` plus a path, so a path here would be doubled in them. The
 * place of a client on a shared host (`/app`, `/pwa`) is that client's own setting, not part of this
 * address.
 */
const publicOrigin = z
  .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .refine((value) => new URL(value).pathname === '/', {
    error: 'must be an origin without a path (the API lives at <origin>/api)',
  })
  .transform((value) => value.replace(/\/+$/, ''))

const booleanFlag = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return value
}, z.boolean().optional())

const optionalInt = (min = 0) => z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).optional())

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const
/** memory is for tests only (APP_ENV=local): emails are collected in process memory. */
export const EMAIL_TRANSPORTS = ['smtp', 'console', 'memory'] as const
/**
 * Codecs of the agent's speech the dialog gateway can send, by their names in the client contract
 * (`TTS_CODECS` in @ryadom/contracts; the core does not depend on it, so the names are repeated here).
 */
export const DIALOG_AUDIO_CODECS = ['opus', 'mulaw', 'pcm16'] as const

/**
 * DIALOG_AUDIO_CODECS: comma-separated codec names, in any order (the client's order decides). pcm16 is
 * always added: it is what a client gets when it named nothing the server offers, old builds included.
 */
const dialogAudioCodecs = z
  .preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((name) => name.trim().toLowerCase())
            .filter(Boolean)
        : value,
    z.array(z.enum(DIALOG_AUDIO_CODECS)).optional(),
  )
  .transform((codecs) => [...new Set([...(codecs ?? []), 'pcm16' as const])])

/**
 * ADMIN_EMAILS: comma-separated admin emails, lowercased into a list (empty means no admins).
 *
 * It lives in the base schema and not only in the admin schema because the core sign-in flow
 * (`admin-authentication`) decides by it, and `getEnv()` reads exactly the base schema. `app`
 * does not set the variable, so it stays an empty list.
 */
const adminEmails = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
)

const baseShape = {
  APP_ENV: z.enum(['local', 'prod']),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default('info')),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Kill switch of links to a conversation (`REQ-DATA-05`): on by default, this turns creating and opening them off. */
  DIALOG_SHARE_DISABLED: booleanFlag,
  PUBLIC_WEB_URL: publicUrl,
  /** Where the web client lives (`https://host/app`); the link to a conversation opens there. Without it: `<PUBLIC_APP_URL>/app`. */
  PUBLIC_WEBAPP_URL: z.preprocess(emptyToUndefined, publicUrl.optional()),
  /**
   * Public ORIGIN of the application server (API and OTA bundles): `https://example.com`, never
   * with a path.
   */
  PUBLIC_APP_URL: publicOrigin,
  EMAIL_TRANSPORT: z.enum(EMAIL_TRANSPORTS),
  EMAIL_FROM: z.string().min(3),
  SMTP_HOST: optionalString,
  SMTP_PORT: optionalInt(1),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_SECURE: booleanFlag,
  ADMIN_EMAILS: adminEmails,
  /**
   * How many reverse proxies in front of the service append to `X-Forwarded-For` (see
   * `resolveClientIp`): 1 behind a single ingress or gateway, 2 with a CDN in front of it, 0 to
   * ignore the header altogether. The client address, and with it every per-IP rate limit, comes
   * from the entry the outermost trusted proxy added, never from the one the client wrote.
   */
  TRUSTED_PROXY_HOPS: optionalInt(0).transform((value) => value ?? 1),
  /**
   * Dialog agent: REST base URL (the WebSocket address is derived from it, http -> ws) and the
   * shared secret. In the base schema and not only in `app` because the admin panel calls the
   * agent too: deleting an account erases the person's data there.
   */
  AGENT_API_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
    .transform((value) => value.replace(/\/+$/, '')),
  /** Empty means no authorization header is sent to the agent (local mock). */
  AGENT_API_TOKEN: optionalString,
  AGENT_TIMEOUT_MS: optionalInt(1000).transform((value) => value ?? 10_000),
  /**
   * The Telegram bot whose Mini App opens the PWA. Telegram signs the launch data (`initData`) it hands
   * the app with a key derived from this token, and the token is what checks it on sign-in. A SECRET:
   * whoever holds it can act as the bot and sign launch data for any Telegram user, so it lives in a
   * Secret. Empty switches sign-in from Telegram off.
   */
  TELEGRAM_BOT_TOKEN: optionalString,
  /**
   * How old the launch data may be, in seconds. It is made when the Mini App opens and the app uses it
   * when there is no session; the limit is what a copy that leaked is good for.
   */
  TELEGRAM_INIT_DATA_MAX_AGE_SEC: optionalInt(60).transform((value) => value ?? 86_400),
}

const appShape = {
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3002)),
  MOBILE_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** After this many seconds without frames the server closes the socket. */
  DIALOG_IDLE_TIMEOUT_SEC: optionalInt(30).transform((value) => value ?? 900),
  /** Hard cap on a single connection: protection against sockets that never end on rollouts. */
  DIALOG_MAX_DURATION_SEC: optionalInt(60).transform((value) => value ?? 7200),
  /**
   * How often an open dialog asks the registry whether its session is still alive. The access token
   * is checked once, at `hello`, and says nothing about a session that was ended afterwards; this is
   * how long such a dialog can go on at most.
   */
  DIALOG_SESSION_CHECK_SEC: optionalInt(1).transform((value) => value ?? 30),
  /**
   * What the gateway may re-encode the agent's speech into for the client (`opus,mulaw,pcm16`). The
   * client names what it can decode in `hello`, and its first choice among these wins. Empty means pcm16
   * only, the way it was before: 384 kbit/s per speaking dialog. mulaw halves that for almost no CPU;
   * Opus takes it to about 24 kbit/s at roughly 9 ms of CPU per second of speech, off the main thread.
   */
  DIALOG_AUDIO_CODECS: dialogAudioCodecs,
  /** Opus encoder of the agent's speech: complexity 0..10 (5 measured as the knee: PESQ 4.16 at 7 ms/s). */
  DIALOG_OPUS_COMPLEXITY: z
    .preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(10).optional())
    .transform((value) => value ?? 5),
  /** Opus bitrate, bit/s. 24000 keeps speech at 24 kHz clean (PESQ above 4); lower starts to blur it. */
  DIALOG_OPUS_BITRATE: z
    .preprocess(emptyToUndefined, z.coerce.number().int().min(6_000).max(128_000).optional())
    .transform((value) => value ?? 24_000),
  /**
   * State shared by the replicas; for now only the rate limits. Off by default: each replica then
   * counts on its own, and the real limit is the stated one times the number of replicas. With it
   * on, the address is either `REDIS_URL` (one node, local development) or Sentinel, whose password
   * `REDIS_PASSWORD` serves the Sentinel nodes and the master alike.
   */
  REDIS_ENABLED: booleanFlag,
  REDIS_URL: z.preprocess(
    emptyToUndefined,
    z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }).optional(),
  ),
  REDIS_SENTINEL_HOST: optionalString,
  REDIS_SENTINEL_PORT: optionalInt(1).transform((value) => value ?? 26379),
  REDIS_MASTER_NAME: optionalString,
  REDIS_PASSWORD: optionalString,
  /**
   * The hourly job that erases anonymous accounts nobody has opened for `ANONYMOUS_RETENTION_DAYS`
   * (contracts). On by default, because the app promises it; this is the switch to stop it, for
   * instance while the agent is being migrated and could not confirm its erasures.
   */
  ANONYMOUS_PURGE_DISABLED: booleanFlag,
  /**
   * Native version gate: store links plus the min/latest build per platform. There is
   * no bucket manifest any more - the JS/OTA axis is baked into the image (`lib/ota-bundle.ts`) and
   * ships with every deploy, while this native axis changes only on a store release (rare, and
   * usually not in step with a deploy), so it stays in env, meant for a ConfigMap the release
   * process edits by hand. 0 means "no gate/banner for this platform".
   */
  MOBILE_ANDROID_STORE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MOBILE_ANDROID_MIN_VERSION_CODE: optionalInt(0).transform((value) => value ?? 0),
  MOBILE_ANDROID_LATEST_VERSION_CODE: optionalInt(0).transform((value) => value ?? 0),
  /** Direct APK link; empty means the app offers only the store. */
  MOBILE_ANDROID_DOWNLOAD_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MOBILE_IOS_STORE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MOBILE_IOS_MIN_VERSION_CODE: optionalInt(0).transform((value) => value ?? 0),
  MOBILE_IOS_LATEST_VERSION_CODE: optionalInt(0).transform((value) => value ?? 0),
  /**
   * Product analytics (PostHog). The project token is public by design (it only lets events in), so
   * it belongs in the ConfigMap rather than a Secret. Empty switches analytics off altogether: the
   * server reports nothing, `/api/ingest` is a 404 and the clients are told not to load the SDK
   * (`GET /api/analytics/config`). What the clients collect is fixed in their code (`buildSdkConfig`).
   *
   * LEGAL RISKS (Russian law) of every option below, in short. A research summary from 2026-10-10, not a
   * lawyer's opinion; sources and detail in docs/analytics.md ("Правовые риски"):
   * - events with an account id stay personal data of the operator (152-FZ art. 3 p. 1, 9, art. 13.1):
   *   "depersonalised" does not mean "not personal data", and they are never "anonymous";
   * - a cloud analytics service abroad is a cross-border transfer (art. 3 p. 11, art. 12): Roskomnadzor must
   *   be notified before it starts (part 3), the recipient must give the data of parts 4-5, processing is
   *   delegated by contract (art. 6 part 3);
   * - client events pass through our proxy straight into a foreign database and are recorded nowhere in
   *   Russia: localisation risk, art. 18 part 5 (Administrative Code 13.11 part 8: RUB 1-6 m for a company);
   * - no legal basis is settled: the opt-out switch is not consent (art. 9), and art. 6(1) p. 7 and p. 9 are
   *   not confirmed in practice for product analytics; since 2025-09-01 consent is a separate document;
   * - tension_* with an account id may count as health data (art. 10: written consent, higher fines).
   * Each option carries its own risk on top of these.
   *
   * POSTHOG_KEY carries all of the above: if the notification (art. 12 part 3) is not filed and there is no
   * contract with the recipient, the legally safer value is empty, which stops every report.
   */
  POSTHOG_KEY: optionalString,
  /** Where events go. The EU cloud keeps the data in the EU. */
  POSTHOG_HOST: z.preprocess(emptyToUndefined, publicUrl.default('https://eu.i.posthog.com')),
  /** Where the SDK's lazy-loaded scripts come from (dead clicks, web vitals, error tracking). */
  POSTHOG_ASSETS_HOST: z.preprocess(emptyToUndefined, publicUrl.default('https://eu-assets.i.posthog.com')),
  /** The PostHog web app, for links such as the toolbar, and the host of its management API. */
  POSTHOG_UI_HOST: z.preprocess(emptyToUndefined, publicUrl.default('https://eu.posthog.com')),
  /**
   * What lets the server erase a person from PostHog when their account is deleted («erase
   * everything» is a promise of the product). A personal API key with the `person:write` scope: a
   * SECRET, unlike the project token, so it belongs in the Secret, never the ConfigMap. Needs both
   * variables: with one of them missing (say the ConfigMap is applied before the Secret exists) the
   * server still starts and analytics still work, but a deleted account's pseudonymous profile stays
   * in PostHog until someone removes it by hand, and the server says so in the log at startup.
   * Deliberately not a startup failure: an optional analytics feature must not keep the API down.
   *
   * RISK of the key: it sits in the environment of a public API, and a leaked key with wide rights is a
   * leak of the analytics data (art. 19 protection measures; Administrative Code 13.11 parts 15-16, 18:
   * turnover-based fines). Give it the single scope `person:write` on the one project.
   */
  POSTHOG_PERSONAL_API_KEY: optionalString,
  POSTHOG_PROJECT_ID: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^\d+$/, 'must be the numeric id of the PostHog project').optional(),
  ),
  /**
   * Whether erasing a deleted account's person in PostHog also erases that person's events. On by
   * default: «erase everything». Off keeps the events (the profile and recordings still go), so past
   * activity can still be counted; the events are then pseudonymous (an account id, no text, no email)
   * and not anonymous while the deletion archive in the database still maps that id to a person.
   *
   * RISK of off: personal data kept longer than the purpose (art. 5 part 7) and, after withdrawal of consent
   * or achievement of the purpose, due for destruction within 30 days (art. 21 parts 4-5).
   */
  POSTHOG_ERASE_EVENTS: booleanFlag.transform((value) => value ?? true),
  /**
   * The build that runs (the image tag), sent with every analytics event as `app_version` so a figure can be
   * split by release. Set at image build time (`--build-arg RELEASE=<tag>`); empty means the events carry none.
   */
  RELEASE: z.string().trim().max(64).optional(),
  /**
   * Accounts made by a device whose id starts with this are marked `test` (`users.properties.traffic_type`)
   * and tagged so in every analytics event: the load tests' device ids carry it, which is how their traffic
   * stays out of the figures without a hand-kept list. Empty switches the rule off. A real device id is
   * random base64 and does not start with a word.
   */
  ANALYTICS_TEST_DEVICE_PREFIX: z.string().trim().max(32).default('loadtest-'),
}

const adminShape = {
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3001)),
}

const baseObject = z.object(baseShape)
const appObject = z.object({ ...baseShape, ...appShape })
type BaseEnvInput = z.infer<typeof baseObject>

/** Conditional requirements: email transport. */
function refineBase(env: BaseEnvInput, ctx: z.RefinementCtx): void {
  const require = (key: keyof BaseEnvInput, why: string) => {
    if (env[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: `required when ${why}` })
  }
  if (env.EMAIL_TRANSPORT === 'smtp') {
    require('SMTP_HOST', 'EMAIL_TRANSPORT=smtp')
    require('SMTP_PORT', 'EMAIL_TRANSPORT=smtp')
  }
  if (env.EMAIL_TRANSPORT === 'memory' && env.APP_ENV !== 'local') {
    ctx.addIssue({
      code: 'custom',
      path: ['EMAIL_TRANSPORT'],
      message: 'memory is allowed only with APP_ENV=local',
    })
  }
}

/** The app's own conditional requirements: Redis needs an address. */
function refineApp(env: z.infer<typeof appObject>, ctx: z.RefinementCtx): void {
  if (!env.REDIS_ENABLED || env.REDIS_URL) return
  for (const key of ['REDIS_SENTINEL_HOST', 'REDIS_MASTER_NAME'] as const) {
    if (env[key] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'required when REDIS_ENABLED=true without REDIS_URL',
      })
    }
  }
}

/**
 * Conditional checks run even when other fields already have errors, so that startup reports
 * every env problem at once instead of one at a time.
 */
const refineAlways = {
  when: (payload: { value: unknown }) => typeof payload.value === 'object' && payload.value !== null,
}

/** Variables shared by admin and app. */
export const baseServerEnvSchema = z.object(baseShape).superRefine(refineBase, refineAlways)
/** admin: shared variables plus PORT. The admin list stays in the shared ones, read by the core. */
export const adminEnvSchema = z.object({ ...baseShape, ...adminShape }).superRefine(refineBase, refineAlways)
/** app: shared variables plus PORT, JWT, agent and version policy. */
export const appEnvSchema = appObject
  .superRefine(refineBase, refineAlways)
  .superRefine(refineApp, refineAlways)
/** What the core itself reads: the shared variables (the core has no sessions, so no JWT secrets). */
export const coreEnvSchema = z.object(baseShape).superRefine(refineBase, refineAlways)

export type BaseServerEnv = z.infer<typeof baseServerEnvSchema>
export type AdminEnv = z.infer<typeof adminEnvSchema>
export type AppEnv = z.infer<typeof appEnvSchema>
export type CoreEnv = z.infer<typeof coreEnvSchema>

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment variables:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
    this.name = 'EnvValidationError'
  }
}

/**
 * Validates env against the schema and returns a typed object; on failure throws
 * EnvValidationError with every problem at once. Applications call it at startup:
 * `loadEnv(adminEnvSchema)` / `loadEnv(appEnvSchema)`.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source)
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
    )
  }
  return result.data
}

let cached: CoreEnv | undefined

/** Core env: validated on first access and cached for the process. */
export function getEnv(): CoreEnv {
  cached ??= loadEnv(coreEnvSchema)
  return cached
}

/** For tests: reset the cache after vi.stubEnv. */
export function resetEnvCache(): void {
  cached = undefined
}
