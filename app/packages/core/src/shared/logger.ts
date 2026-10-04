import {
  destination,
  multistream,
  pino,
  stdSerializers,
  stdTimeFunctions,
  type DestinationStream,
  type Logger as PinoLogger,
} from 'pino'
import { isTelemetryEnabled, otelLogStream } from './telemetry'

/**
 * Core logger: JSON to stdout (pino), plus OTLP to VictoriaLogs when `OTEL_ENABLED=true`
 * (telemetry.ts). In this interface `warn`/`error` take the error as the second argument and the
 * data last. The application decides which fields to strip, through `configureLogger` at startup.
 */
export type LogData = Record<string, unknown>

export interface Logger {
  debug(message: string, data?: LogData): void
  info(message: string, data?: LogData): void
  warn(message: string, error?: unknown, data?: LogData): void
  error(message: string, error?: unknown, data?: LogData): void
}

export interface LoggerSettings {
  /**
   * What to strip from records. A key without a dot covers the field at the top level and one
   * level deeper (`password` becomes `password` and `*.password`); a key with a dot is used as a
   * pino path verbatim (`req.headers.cookie`).
   */
  redact: readonly string[]
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const

/**
 * The settings live on globalThis rather than in the module: in Next.js the instrumentation that
 * sets them and the routes can end up with different copies of the core modules.
 */
const SETTINGS = Symbol.for('ryadom.logger.settings')
type SettingsHolder = { [SETTINGS]?: LoggerSettings }

let root: PinoLogger | undefined

/**
 * Logger settings supplied by the application. Call it at startup, before the first log record:
 * web in `instrumentation.ts`, the API in `services/api/src/index.ts`.
 */
export function configureLogger(settings: LoggerSettings): void {
  if (root) throw new Error('configureLogger must be called at startup, before the first log record')
  ;(globalThis as SettingsHolder)[SETTINGS] = settings
}

function redactPaths(): string[] {
  const keys = (globalThis as SettingsHolder)[SETTINGS]?.redact ?? []
  return keys.flatMap((key) => (key.includes('.') ? [key] : [key, `*.${key}`]))
}

/**
 * Drizzle errors carry query parameters (in message, stack and the params field), which may hold
 * hashes and tokens. Only the query text reaches the log.
 */
function serializeError(error: unknown): Record<string, unknown> {
  const serialized = stdSerializers.err(error as Error) as unknown as Record<string, unknown>
  const strip = (value: unknown) =>
    typeof value === 'string' ? value.replace(/\nparams: [^\n]*/g, '') : value
  const clean = (value: Record<string, unknown>): Record<string, unknown> => {
    const { params: _params, ...rest } = value
    const cause = rest.cause
    return {
      ...rest,
      message: strip(rest.message),
      stack: strip(rest.stack),
      ...(cause && typeof cause === 'object' ? { cause: clean(cause as Record<string, unknown>) } : {}),
    }
  }
  return clean(serialized)
}

function levelFromEnv(): (typeof LOG_LEVELS)[number] {
  const value = process.env.LOG_LEVEL?.toLowerCase()
  return (LOG_LEVELS as readonly string[]).includes(value ?? '')
    ? (value as (typeof LOG_LEVELS)[number])
    : 'info'
}

/**
 * Without OTLP, pino's default stream (stdout). With OTLP, both stdout and OTel; the logger itself
 * filters by level, so the streams accept everything.
 */
function logDestination(): DestinationStream | undefined {
  if (!isTelemetryEnabled()) return undefined
  return multistream([
    { level: 'trace', stream: destination(1) },
    { level: 'trace', stream: otelLogStream },
  ])
}

/** Root pino logger, for applications that need pino directly, pino-http for example. */
export function getRootLogger(): PinoLogger {
  root ??= pino(
    {
      level: levelFromEnv(),
      base: { service: 'ryadom', env: process.env.APP_ENV },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: redactPaths(), censor: '[redacted]' },
      serializers: { err: serializeError },
    },
    logDestination(),
  )
  return root
}

export function isDebugEnabled(): boolean {
  return getRootLogger().isLevelEnabled('debug')
}

export function createLogger(component: string): Logger {
  const log = () => getRootLogger()
  return {
    debug: (message, data) => log().debug({ component, ...data }, message),
    info: (message, data) => log().info({ component, ...data }, message),
    warn: (message, error, data) =>
      log().warn({ component, ...data, ...(error === undefined ? {} : { err: error }) }, message),
    error: (message, error, data) =>
      log().error({ component, ...data, ...(error === undefined ? {} : { err: error }) }, message),
  }
}
