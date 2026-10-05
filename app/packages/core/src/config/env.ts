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
  APP_ENV: z.enum(['local', 'staging', 'prod']),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).default('info')),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  PUBLIC_WEB_URL: publicUrl,
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
  // Logs over OTLP when the infrastructure collects them; the OTel exporter reads these from
  // process.env on its own.
  OTEL_ENABLED: booleanFlag,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  ),
  OTEL_SERVICE_NAME: optionalString,
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
  if (env.OTEL_ENABLED) require('OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_ENABLED=true')
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
