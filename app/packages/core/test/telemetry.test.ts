import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EnvValidationError, loadEnv, adminEnvSchema } from '../src/config'
import { otelLogStream } from '../src/shared/telemetry'

const exporter = new InMemoryLogRecordExporter()
const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] })

beforeAll(() => {
  logs.setGlobalLoggerProvider(provider)
})

afterAll(() => {
  logs.disable()
})

beforeEach(() => {
  exporter.reset()
})

describe('otelLogStream', () => {
  it('переносит уровень, время и текст, вложенные поля — плоскими атрибутами', async () => {
    otelLogStream.write(
      JSON.stringify({
        level: 'error',
        time: '2026-09-24T10:00:00.000Z',
        service: 'ryadom',
        env: 'staging',
        component: 'authentication',
        userId: 'u-1',
        err: { type: 'Error', message: 'boom', stack: 'Error: boom\n    at x' },
        tags: ['a', 'b'],
        empty: null,
        msg: 'Login failed',
      }) + '\n',
    )
    await provider.forceFlush()

    const [record] = exporter.getFinishedLogRecords()
    expect(record).toBeDefined()
    expect(record!.severityNumber).toBe(SeverityNumber.ERROR)
    expect(record!.severityText).toBe('ERROR')
    expect(record!.body).toBe('Login failed')
    expect(new Date(record!.hrTime[0] * 1000).toISOString()).toBe('2026-09-24T10:00:00.000Z')
    expect(record!.attributes).toEqual({
      component: 'authentication',
      userId: 'u-1',
      'err.type': 'Error',
      'err.message': 'boom',
      'err.stack': 'Error: boom\n    at x',
      tags: '["a","b"]',
    })
  })

  it('битая строка не бросает и ничего не отправляет', async () => {
    expect(() => otelLogStream.write('not json')).not.toThrow()
    await provider.forceFlush()
    expect(exporter.getFinishedLogRecords()).toHaveLength(0)
  })
})

describe('env OTEL_*', () => {
  const env = {
    APP_ENV: 'staging',
    DATABASE_URL: 'postgres://u:p@db:5432/ryadom_staging',
    AUTH_SECRET: 'x'.repeat(32),
    PUBLIC_WEB_URL: 'https://staging.example.ru',
    PUBLIC_APP_URL: 'https://app.staging.example.ru',
    EMAIL_TRANSPORT: 'console',
    EMAIL_FROM: 'Рядом <noreply@example.ru>',
    AGENT_API_URL: 'http://agent-api:8000',
  }

  it('OTEL_ENABLED=true без адреса — ошибка env', () => {
    expect(() => loadEnv(adminEnvSchema, { ...env, OTEL_ENABLED: 'true' })).toThrow(EnvValidationError)
  })

  it('с адресом VictoriaLogs — проходит', () => {
    const parsed = loadEnv(adminEnvSchema, {
      ...env,
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://victorialogs:9428/insert/opentelemetry',
      OTEL_SERVICE_NAME: 'ryadom-admin',
    })
    expect(parsed.OTEL_ENABLED).toBe(true)
  })
})
