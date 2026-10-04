/**
 * Crisis lines, hard-coded in the source on purpose: a page that lists help must
 * not depend on configuration being present.
 *
 * The same three lines are built into the app (client and server). The lists must stay
 * identical: a person who saw a number on the site should find the same one in the app.
 */
export interface Hotline {
  name: string
  phone: string
  note: string
}

export const HOTLINES: Hotline[] = [
  {
    name: 'Экстренные службы',
    phone: '112',
    note: 'Круглосуточно, с любого телефона, даже без сим-карты.',
  },
  {
    name: 'Психологическая помощь МЧС России',
    phone: '8 (495) 989-50-50',
    note: 'Круглосуточно, бесплатно, анонимно.',
  },
  {
    name: 'Московская служба психологической помощи',
    phone: '8 (495) 575-03-16',
    note: 'Круглосуточно, бесплатно.',
  },
]

/** The number is written the way it is read aloud; `tel:` keeps only the digits and the plus sign. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, '')}`
}
