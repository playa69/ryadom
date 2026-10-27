/**
 * The OTA archive and the JS inside it must agree on the version, or an applied bundle is offered again
 * forever and a rollback arrives as a background update.
 * `openspec/changes/add-required-js-update`, «Сборка OTA-пакета и манифест».
 */
import { describe, expect, it } from 'vitest'
import { jsVersion } from '../scripts/js-version.mjs'

describe('версия JS', () => {
  it('версия клиента и номер сборки, без номера — .0', () => {
    expect(jsVersion('0.1.0', '42')).toBe('0.1.0.42')
    expect(jsVersion('0.1.0', ' 42 ')).toBe('0.1.0.42')
    expect(jsVersion('0.1.0', undefined)).toBe('0.1.0.0')
    expect(jsVersion('0.1.0', '')).toBe('0.1.0.0')
  })

  it('номер сборки не из 1–6 цифр останавливает сборку', () => {
    for (const bad of ['abc', '1234567', '-1', '4.2']) expect(() => jsVersion('0.1.0', bad)).toThrow(/OTA_BUILD_NUMBER/)
  })

  it('JS этой сборки сообщает ту же версию, что и манифест пакета', () => {
    expect(__JS_VERSION__).toBe(jsVersion('0.1.0'))
  })
})
