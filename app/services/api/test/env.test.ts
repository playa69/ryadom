import { describe, expect, it } from 'vitest'
import { createAnalytics, hasInvalidProjectToken, projectToken, toAnalyticsConfig } from '../src/lib/analytics'
import { parseEnv } from '../src/lib/env'
import { createLogger } from '../src/lib/logger'

describe('настройка PUBLIC_APP_URL', () => {
  it('PUBLIC_APP_URL — только origin: путь в нём удвоился бы в адресах OTA-бандлов', () => {
    expect(parseEnv({ ...process.env, PUBLIC_APP_URL: 'https://example.com/' }).PUBLIC_APP_URL).toBe('https://example.com')
    expect(() => parseEnv({ ...process.env, PUBLIC_APP_URL: 'https://example.com/app' })).toThrow(/PUBLIC_APP_URL/)
  })
})

describe('настройка PostHog', () => {
  it('без ключа аналитика выключена, хосты — EU cloud, чувствительное выключено', () => {
    const env = parseEnv({ ...process.env, POSTHOG_KEY: '' })
    expect(env.POSTHOG_KEY).toBeUndefined()
    expect(env.POSTHOG_HOST).toBe('https://eu.i.posthog.com')
    expect(env.POSTHOG_ASSETS_HOST).toBe('https://eu-assets.i.posthog.com')
    expect(env.POSTHOG_UI_HOST).toBe('https://eu.posthog.com')
    expect([env.POSTHOG_SESSION_REPLAY, env.POSTHOG_CLICK_CAPTURE, env.POSTHOG_HEATMAP_CAPTURE]).toEqual([false, false, false])
  })

  it('стирание профилей нужно и ключу, и id проекта; если нет одного из них, под всё равно стартует', () => {
    const logger = createLogger('silent')
    const base = { ...process.env, POSTHOG_KEY: 'phc_TestProjectToken0123456789' }

    // The ConfigMap may be applied before the Secret exists: that must not keep the API from starting.
    const keyOnly = parseEnv({ ...base, POSTHOG_PERSONAL_API_KEY: 'phx_x' })
    expect(createAnalytics(keyOnly, logger).canErase).toBe(false)
    const projectOnly = parseEnv({ ...base, POSTHOG_PROJECT_ID: '300786' })
    expect(createAnalytics(projectOnly, logger).canErase).toBe(false)

    const both = parseEnv({ ...base, POSTHOG_PERSONAL_API_KEY: 'phx_x', POSTHOG_PROJECT_ID: '300786' })
    expect(createAnalytics(both, logger).canErase).toBe(true)
  })

  it('события стёртого аккаунта по умолчанию стираются; оставить историю можно только явно', () => {
    expect(parseEnv({ ...process.env }).POSTHOG_ERASE_EVENTS).toBe(true)
    expect(parseEnv({ ...process.env, POSTHOG_ERASE_EVENTS: 'false' }).POSTHOG_ERASE_EVENTS).toBe(false)
  })

  it('личный ключ (phx_…) в POSTHOG_KEY не уходит клиентам: аналитика выключается, значение не раскрывается', () => {
    const personalKey = `phx_${'A1b2'.repeat(12)}`
    const env = parseEnv({ ...process.env, POSTHOG_KEY: personalKey })
    expect(hasInvalidProjectToken(env)).toBe(true)
    expect(projectToken(env)).toBeUndefined()
    const config = toAnalyticsConfig(env)
    expect(config).toMatchObject({ enabled: false, key: null })
    expect(JSON.stringify(config)).not.toContain(personalKey)
    expect(createAnalytics(env, createLogger('silent')).enabled).toBe(false)
  })

  it('настоящий токен проекта (phc_…) принимается', () => {
    const env = parseEnv({ ...process.env, POSTHOG_KEY: 'phc_ValidProjectToken0123456789' })
    expect(hasInvalidProjectToken(env)).toBe(false)
    expect(toAnalyticsConfig(env)).toMatchObject({ enabled: true, key: 'phc_ValidProjectToken0123456789' })
  })

  it('id проекта — число', () => {
    expect(() => parseEnv({ ...process.env, POSTHOG_PROJECT_ID: 'ryadom' })).toThrow(/POSTHOG_PROJECT_ID/)
  })
})
