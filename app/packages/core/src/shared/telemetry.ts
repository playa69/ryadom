import { logs, SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'

/**
 * Logs over OTLP: the same records pino writes to stdout also go to VictoriaLogs on the VM.
 * Enabled by `OTEL_ENABLED=true`; the address is the standard `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (the exporter appends `/v1/logs` itself) and the service name is `OTEL_SERVICE_NAME`.
 * The application calls `startTelemetry()` at startup and `shutdownTelemetry()` on shutdown.
 */

let provider: LoggerProvider | undefined

export function isTelemetryEnabled(): boolean {
  return /^(true|1|yes|on)$/i.test(process.env.OTEL_ENABLED?.trim() ?? '')
}

export function startTelemetry(): void {
  if (provider || !isTelemetryEnabled()) return
  provider = new LoggerProvider({
    // VictoriaLogs turns resource attributes into stream fields, which is what queries filter on first.
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME || 'ryadom',
      'deployment.environment.name': process.env.APP_ENV ?? 'local',
    }),
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  })
  // A global provider rather than a module-level reference: in Next.js the instrumentation and
  // the routes can get different copies of the core modules, but the global API is shared.
  logs.setGlobalLoggerProvider(provider)
}

/** Flushes what is buffered and stops the export. */
export async function shutdownTelemetry(): Promise<void> {
  const current = provider
  provider = undefined
  await current?.shutdown()
}

const SEVERITY: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
}

/** Pino fields that become part of the record itself or of the resource, not attributes. */
const OWN_FIELDS = new Set(['level', 'time', 'msg', 'service', 'env'])

const MAX_DEPTH = 4

/** Nested objects become flat dotted keys (`err.message`); arrays become a JSON string. */
function flatten(value: Record<string, unknown>, prefix = '', depth = 0, out: AnyValueMap = {}): AnyValueMap {
  for (const [key, item] of Object.entries(value)) {
    if (!prefix && OWN_FIELDS.has(key)) continue
    const name = prefix ? `${prefix}.${key}` : key
    if (item === null || item === undefined) continue
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[name] = item
    else if (typeof item === 'object' && !Array.isArray(item) && depth < MAX_DEPTH)
      flatten(item as Record<string, unknown>, name, depth + 1, out)
    else out[name] = JSON.stringify(item)
  }
  return out
}

/**
 * A pino stream: the JSON line produced after redaction and the serializers becomes an OTel
 * record. Until the provider is started the global API returns a no-op logger and the record is
 * simply dropped. A failure here must not break the code that writes the log.
 */
export const otelLogStream = {
  write(line: string): void {
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const level = typeof record.level === 'string' ? record.level : 'info'
      logs.getLogger('ryadom').emit({
        timestamp: typeof record.time === 'string' ? new Date(record.time) : new Date(),
        severityNumber: SEVERITY[level] ?? SeverityNumber.INFO,
        severityText: level.toUpperCase(),
        body: typeof record.msg === 'string' ? record.msg : '',
        attributes: flatten(record),
      })
    } catch {
      // The record is already in stdout, which is enough.
    }
  },
}
