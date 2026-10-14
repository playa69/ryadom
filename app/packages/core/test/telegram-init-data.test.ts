/**
 * The check of Telegram Mini App launch data: the signature of our bot, the age, and the Telegram user
 * it names. Pure functions, no database.
 */
import { describe, expect, it } from 'vitest'
import { checkInitData, signInitData } from '../src/services/telegram-service'

const TOKEN = '123456789:test-bot-token'
const NOW = new Date('2026-10-14T12:00:00Z')
const nowSec = NOW.getTime() / 1000
const DAY_SEC = 86_400

const fields = (overrides: Record<string, string> = {}): Record<string, string> => ({
  auth_date: String(nowSec - 60),
  query_id: 'AAH-1',
  user: JSON.stringify({ id: 7_123_456_789, first_name: 'Аня', username: 'anya' }),
  ...overrides,
})

describe('данные запуска Telegram', () => {
  it('подписанные нашим ботом и свежие — принимаются', () => {
    const check = checkInitData(signInitData(fields(), TOKEN), TOKEN, DAY_SEC, NOW)
    expect(check).toEqual({
      ok: true,
      user: { id: 7_123_456_789, firstName: 'Аня' },
      authDate: new Date((nowSec - 60) * 1000),
    })
  })

  it('подписанные другим ботом — нет', () => {
    expect(checkInitData(signInitData(fields(), '999:other'), TOKEN, DAY_SEC, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('любая правка после подписи ломает её', () => {
    const signed = signInitData(fields(), TOKEN)
    const tampered = signed.replace('7123456789', '7123456780')
    expect(checkInitData(tampered, TOKEN, DAY_SEC, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
    const added = `${signed}&chat_type=private`
    expect(checkInitData(added, TOKEN, DAY_SEC, NOW)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('поле signature: принимаются обе версии подписанного текста', () => {
    const withSignature = fields({ signature: 'c2lnbmF0dXJl' })
    expect(checkInitData(signInitData(withSignature, TOKEN), TOKEN, DAY_SEC, NOW).ok).toBe(true)

    const { signature, ...rest } = withSignature
    const signedWithout = new URLSearchParams(signInitData(rest, TOKEN))
    signedWithout.set('signature', signature!)
    expect(checkInitData(signedWithout.toString(), TOKEN, DAY_SEC, NOW).ok).toBe(true)
  })

  it('старше допустимого — просрочены, из будущего — подделка', () => {
    const old = signInitData(fields({ auth_date: String(nowSec - DAY_SEC - 1) }), TOKEN)
    expect(checkInitData(old, TOKEN, DAY_SEC, NOW)).toEqual({ ok: false, reason: 'expired' })
    const future = signInitData(fields({ auth_date: String(nowSec + 3600) }), TOKEN)
    expect(checkInitData(future, TOKEN, DAY_SEC, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('без пользователя, без хэша и с мусором — malformed', () => {
    const { user: _user, ...withoutUser } = fields()
    expect(checkInitData(signInitData(withoutUser, TOKEN), TOKEN, DAY_SEC, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(checkInitData('auth_date=1&user=%7B%7D', TOKEN, DAY_SEC, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(checkInitData('', TOKEN, DAY_SEC, NOW)).toEqual({ ok: false, reason: 'malformed' })
    const badId = signInitData(fields({ user: JSON.stringify({ id: '42' }) }), TOKEN)
    expect(checkInitData(badId, TOKEN, DAY_SEC, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })
})
