/**
 * The client address behind reverse proxies: the entry our own proxy appended to X-Forwarded-For,
 * never the one the client wrote.
 */
import { describe, expect, it } from 'vitest'
import { resolveClientIp, UNKNOWN_CLIENT_IP } from '../src/shared/client-ip'

describe('resolveClientIp', () => {
  it('за одним прокси берёт адрес, который он дописал в конец', () => {
    expect(resolveClientIp('203.0.113.7', undefined, 1)).toBe('203.0.113.7')
    // The client wrote the first entry itself; the proxy appended the real address after it.
    expect(resolveClientIp('198.51.100.1, 203.0.113.7', undefined, 1)).toBe('203.0.113.7')
    expect(resolveClientIp('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7', undefined, 1)).toBe('203.0.113.7')
  })

  it('подмена первого адреса не меняет результат', () => {
    const real = '203.0.113.7'
    const results = new Set(
      ['198.51.100.1', '198.51.100.2', '10.0.0.1', 'не-адрес', '::1'].map((fake) =>
        resolveClientIp(`${fake}, ${real}`, undefined, 1),
      ),
    )
    expect(results).toEqual(new Set([real]))
  })

  it('с несколькими доверенными прокси отсчитывает от конца', () => {
    // client -> CDN (appends the client) -> gateway (appends the CDN)
    expect(resolveClientIp('203.0.113.7, 192.0.2.10', undefined, 2)).toBe('203.0.113.7')
    expect(resolveClientIp('fake, 203.0.113.7, 192.0.2.10', undefined, 2)).toBe('203.0.113.7')
  })

  it('если записей меньше, чем прокси, берёт первую', () => {
    expect(resolveClientIp('203.0.113.7', undefined, 3)).toBe('203.0.113.7')
  })

  it('терпит пробелы и пустые элементы', () => {
    expect(resolveClientIp('  198.51.100.1 ,, 203.0.113.7  ', undefined, 1)).toBe('203.0.113.7')
    expect(resolveClientIp(' , ,', undefined, 1)).toBe(UNKNOWN_CLIENT_IP)
  })

  it('без X-Forwarded-For использует X-Real-IP, а без обоих — «unknown»', () => {
    expect(resolveClientIp(undefined, ' 203.0.113.7 ', 1)).toBe('203.0.113.7')
    expect(resolveClientIp(null, null, 1)).toBe(UNKNOWN_CLIENT_IP)
    expect(resolveClientIp('', '', 1)).toBe(UNKNOWN_CLIENT_IP)
  })

  it('с нулём доверенных прокси заголовки игнорируются: адрес один на всех', () => {
    expect(resolveClientIp('203.0.113.7', '203.0.113.8', 0)).toBe(UNKNOWN_CLIENT_IP)
  })
})
