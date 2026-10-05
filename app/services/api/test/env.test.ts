import { describe, expect, it } from 'vitest'
import { parseEnv } from '../src/lib/env'

describe('настройка PUBLIC_APP_URL', () => {
  it('PUBLIC_APP_URL — только origin: путь в нём удвоился бы в адресах OTA-бандлов', () => {
    expect(parseEnv({ ...process.env, PUBLIC_APP_URL: 'https://example.com/' }).PUBLIC_APP_URL).toBe('https://example.com')
    expect(() => parseEnv({ ...process.env, PUBLIC_APP_URL: 'https://example.com/app' })).toThrow(/PUBLIC_APP_URL/)
  })
})
