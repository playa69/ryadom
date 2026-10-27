/**
 * Platform contracts: env schemas, emails, health and the core conventions.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  adminEnvSchema,
  appEnvSchema,
  emailTransportConfig,
  EnvValidationError,
  isAdminEmail,
  loadEnv,
} from '../src/config'
import {
  emailRendererService,
  RenderAdminCodeEmailRequest,
  RenderEmailConfirmationEmailRequest,
  RenderForgotPasswordEmailRequest,
  RenderPasswordChangedEmailRequest,
  RenderWelcomeEmailRequest,
} from '../src/services/email-renderer-service'
import { CheckHealthRequest, healthService } from '../src/services/health-service'

const baseEnv = {
  APP_ENV: 'prod',
  DATABASE_URL: 'postgres://u:p@db:5432/ryadom',
  AUTH_SECRET: 'x'.repeat(32),
  PUBLIC_WEB_URL: 'https://example.ru/',
  PUBLIC_APP_URL: 'https://app.example.ru',
  EMAIL_TRANSPORT: 'smtp',
  EMAIL_FROM: 'Рядом <noreply@example.ru>',
  SMTP_HOST: 'mailpit',
  SMTP_PORT: '1025',
  AGENT_API_URL: 'http://agent-api:8000/',
}

describe('config', () => {
  it('разбирает env админки: список почт и слеш в конце адреса', () => {
    const env = loadEnv(adminEnvSchema, { ...baseEnv, ADMIN_EMAILS: ' A@Example.com , b@example.com ,' })

    expect(env.ADMIN_EMAILS).toEqual(['a@example.com', 'b@example.com'])
    expect(isAdminEmail(env, ' A@EXAMPLE.COM ')).toBe(true)
    expect(isAdminEmail(env, 'c@example.com')).toBe(false)
    // A trailing slash is stripped from public addresses, otherwise links would get a double slash.
    expect(env.PUBLIC_WEB_URL).toBe('https://example.ru')
    expect(env.AGENT_API_URL).toBe('http://agent-api:8000')
    expect(env.PORT).toBe(3001)
    expect(emailTransportConfig(env)).toEqual({
      kind: 'smtp',
      host: 'mailpit',
      port: 1025,
      secure: false,
      auth: undefined,
    })
  })

  it('пустой список админов — админов нет', () => {
    const env = loadEnv(adminEnvSchema, { ...baseEnv, ADMIN_EMAILS: '' })
    expect(env.ADMIN_EMAILS).toEqual([])
    expect(isAdminEmail(env, 'a@example.com')).toBe(false)
  })

  it('env приложения: значения по умолчанию у необязательных', () => {
    const env = loadEnv(appEnvSchema, { ...baseEnv, MOBILE_JWT_SECRET: 'y'.repeat(32) })
    expect(env.PORT).toBe(3002)
    expect(env.AGENT_TIMEOUT_MS).toBe(10_000)
    expect(env.DIALOG_IDLE_TIMEOUT_SEC).toBe(900)
    expect(env.DIALOG_MAX_DURATION_SEC).toBe(7200)
    expect(env.DIALOG_SESSION_CHECK_SEC).toBe(30)
    // Speech goes out as PCM16 until the codecs are switched on, so a new image changes nothing by itself.
    expect(env.DIALOG_AUDIO_CODECS).toEqual(['pcm16'])
    expect(env.DIALOG_OPUS_COMPLEXITY).toBe(5)
    expect(env.DIALOG_OPUS_BITRATE).toBe(24_000)
    // No bucket manifest any more: the native axis defaults to "no gate, no banner".
    expect(env.MOBILE_ANDROID_MIN_VERSION_CODE).toBe(0)
    expect(env.MOBILE_ANDROID_LATEST_VERSION_CODE).toBe(0)
    expect(env.MOBILE_IOS_MIN_VERSION_CODE).toBe(0)
    expect(env.MOBILE_IOS_LATEST_VERSION_CODE).toBe(0)
    expect(env.MOBILE_ANDROID_DOWNLOAD_URL).toBeUndefined()
  })

  it('собирает все проблемы env в одну ошибку', () => {
    try {
      loadEnv(appEnvSchema, {
        ...baseEnv,
        APP_ENV: 'prod',
        AUTH_SECRET: 'short',
        MOBILE_JWT_SECRET: 'short',
        EMAIL_TRANSPORT: 'memory',
        SMTP_HOST: '',
        AGENT_API_URL: 'not-a-url',
      })
      expect.unreachable('loadEnv должен был бросить')
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError)
      const issues = (error as EnvValidationError).issues.join('\n')
      expect(issues).toContain('AUTH_SECRET')
      expect(issues).toContain('MOBILE_JWT_SECRET')
      expect(issues).toContain('AGENT_API_URL')
      // The memory transport is allowed only locally: in production it would silently lose emails.
      expect(issues).toContain('EMAIL_TRANSPORT')
    }
  })
})

describe('кодеки озвучки', () => {
  const appEnv = { ...baseEnv, MOBILE_JWT_SECRET: 'y'.repeat(32) }

  it('список через запятую, регистр и пробелы не важны; pcm16 добавляется всегда — его понимает любой клиент', () => {
    expect(
      loadEnv(appEnvSchema, { ...appEnv, DIALOG_AUDIO_CODECS: ' Opus, mulaw ' }).DIALOG_AUDIO_CODECS,
    ).toEqual(['opus', 'mulaw', 'pcm16'])
    expect(
      loadEnv(appEnvSchema, { ...appEnv, DIALOG_AUDIO_CODECS: 'pcm16,opus' }).DIALOG_AUDIO_CODECS,
    ).toEqual(['pcm16', 'opus'])
    expect(loadEnv(appEnvSchema, { ...appEnv, DIALOG_AUDIO_CODECS: '' }).DIALOG_AUDIO_CODECS).toEqual([
      'pcm16',
    ])
  })

  it('опечатка в имени кодека и сложность вне 0..10 не дают стартовать', () => {
    expect(() => loadEnv(appEnvSchema, { ...appEnv, DIALOG_AUDIO_CODECS: 'opus,aac' })).toThrow(
      /DIALOG_AUDIO_CODECS/,
    )
    expect(() => loadEnv(appEnvSchema, { ...appEnv, DIALOG_OPUS_COMPLEXITY: '11' })).toThrow(
      /DIALOG_OPUS_COMPLEXITY/,
    )
    expect(() => loadEnv(appEnvSchema, { ...appEnv, DIALOG_OPUS_BITRATE: '1000' })).toThrow(
      /DIALOG_OPUS_BITRATE/,
    )
  })
})

describe('письма', () => {
  const cases = [
    [
      new RenderWelcomeEmailRequest({ userName: 'Аня', code: '123456', expiresInMinutes: 10 }),
      'Добро пожаловать в «Рядом»',
      ['Привет, Аня!', '123456'],
    ],
    [
      new RenderEmailConfirmationEmailRequest({ userName: null, code: '234567', expiresInMinutes: 10 }),
      'Подтверди почту',
      ['234567'],
    ],
    [
      new RenderForgotPasswordEmailRequest({ userName: 'Аня', code: '345678', expiresInMinutes: 10 }),
      'Смена пароля',
      ['345678'],
    ],
    [
      new RenderPasswordChangedEmailRequest({ userName: 'Аня', changedAt: new Date('2026-10-01T12:00:00Z') }),
      'Пароль изменён',
      ['Привет, Аня!'],
    ],
    [
      new RenderAdminCodeEmailRequest({ code: '456789', expiresInMinutes: 10 }),
      'Код входа в админку',
      ['456789'],
    ],
  ] as const

  it('каждое письмо — с брендом, на «ты» и с текстовой версией', async () => {
    for (const [request, subject, fragments] of cases) {
      const { email } = await emailRendererService.execute(request)
      expect(email.subject).toBe(subject)
      expect(email.html).toContain('<html')
      // The accent of the «Рядом» palette (the dot of the wordmark, in every email): blue.
      expect(email.html).toContain('#0a6cde')
      expect(email.text).toContain('Рядом')
      for (const fragment of fragments) expect(email.text).toContain(fragment)
      // Informal address: «Вы» and «Ваш» never appear in the product emails.
      expect(email.text).not.toMatch(/(^|[^А-Яа-яЁё])(Вы|Ваш|ваш)([^А-Яа-яЁё]|$)/)
      // A non-breaking space before a dash.
      expect(email.text).not.toMatch(/ —/)
    }
  })
})

describe('health', () => {
  it('проверяет базу', async () => {
    const result = await healthService.execute(new CheckHealthRequest())
    expect(result.healthy).toBe(true)
    expect(result.database.ok).toBe(true)
  })
})

describe('конвенции ядра', () => {
  it('команды менеджеров возвращают только успех или код отказа (данные — через queries)', () => {
    const managers = fileURLToPath(new URL('../src/managers', import.meta.url))
    const offenders: string[] = []
    for (const manager of readdirSync(managers)) {
      const commands = join(managers, manager, 'commands')
      for (const command of readdirSync(commands)) {
        const types = readFileSync(join(commands, command, `${command}.types.ts`), 'utf8')
        const result = types.slice(types.indexOf('Result ='))
        if (!/\{ success: true \}/.test(result) || /success: true;/.test(result)) {
          offenders.push(`${manager}/${command}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('у каждого контракта есть static requestName, равный имени класса', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        const text = readFileSync(full, 'utf8')
        const classMatch = /^export class (\w+) extends RequestData</m.exec(text)
        if (!classMatch) continue
        const [, className] = classMatch
        const nameMatch = /static readonly requestName = '([^']*)'/.exec(text)
        if (!nameMatch || nameMatch[1] !== className) {
          offenders.push(`${full.slice(src.length + 1)}: ${className}`)
        }
      }
    }
    walk(src)
    expect(offenders).toEqual([])
  })

  it('в ядре не осталось упоминаний внешних провайдеров входа', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
        const text = readFileSync(full, 'utf8')
        if (/oidc|yandex_client|vkid|OidcProvider/i.test(text)) offenders.push(full.slice(src.length + 1))
      }
    }
    walk(src)
    expect(offenders).toEqual([])
  })
})
