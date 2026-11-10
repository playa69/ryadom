import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'

/**
 * Help lines bundled into the app (always one tap away).
 *
 * The list is hardcoded on purpose: it has to open with no network and with the agent down.
 * Counsellors must verify the numbers before release - this is the safeguard that
 * fires at the worst moment. Shipped in the OTA bundle.
 */
export const HOTLINES: HotlineApiResponse[] = [
  { name: 'Экстренные службы', phone: '112' },
  { name: 'Психологическая помощь МЧС России', phone: '8 (495) 989-50-50' },
  { name: 'Московская служба психологической помощи', phone: '8 (495) 575-03-16' },
]

/** The number is stored the way it is read aloud; `tel:` keeps only digits and the plus. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, '')}`
}
