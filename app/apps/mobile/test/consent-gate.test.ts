/**
 * The decision behind the consent sheet of the PWA/Telegram home (no rendering: the sheet itself is
 * covered by e2e). `openspec/changes/add-fast-dialog-start`, «Согласие при первом действии».
 */
import { describe, expect, it } from 'vitest'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { needsFirstActionConsent } from '../src/client/lib/consent-gate'

describe('лист согласия при первом действии', () => {
  it('новый человек PWA/Telegram без сессии — лист при первом действии', () => {
    // «Окно согласия при отправке текста» / «Окно согласия при голосовом старте».
    expect(
      needsFirstActionConsent({
        native: false,
        authenticated: false,
        consentVersion: undefined,
        confirmedInSession: false,
      }),
    ).toBe(true)
  })

  it('вошедший без актуальной версии согласия — лист', () => {
    for (const consentVersion of [undefined, null, '0-old']) {
      expect(
        needsFirstActionConsent({
          native: false,
          authenticated: true,
          consentVersion,
          confirmedInSession: false,
        }),
        String(consentVersion),
      ).toBe(true)
    }
  })

  it('актуальное согласие записано — листа нет, первое действие сразу начинает разговор', () => {
    // «Согласие уже записано».
    expect(
      needsFirstActionConsent({
        native: false,
        authenticated: true,
        consentVersion: POLICY_VERSION,
        confirmedInSession: false,
      }),
    ).toBe(false)
  })

  it('подтверждение этой сессии не спрашивается повторно: ошибка старта не открывает лист снова', () => {
    // «Ошибка после подтверждения».
    expect(
      needsFirstActionConsent({
        native: false,
        authenticated: false,
        consentVersion: undefined,
        confirmedInSession: true,
      }),
    ).toBe(false)
  })

  it('нативная ветка неизменна: листа нет никогда, прежний предварительный ворот на первом экране', () => {
    // «(Android, iOS) Прежний предварительный ворот».
    expect(
      needsFirstActionConsent({
        native: true,
        authenticated: false,
        consentVersion: undefined,
        confirmedInSession: false,
      }),
    ).toBe(false)
    expect(
      needsFirstActionConsent({
        native: true,
        authenticated: true,
        consentVersion: null,
        confirmedInSession: false,
      }),
    ).toBe(false)
  })
})
