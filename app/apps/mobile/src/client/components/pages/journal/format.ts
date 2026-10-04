import type { DialogListItemApiResponse } from '@ryadom/contracts/api/dialogs'

export function formatJournalDate(iso: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
}

/** A dash never starts a line: the space before it cannot break. */
export function nbspDash(text: string): string {
  return text.replace(/ \u2014 /g, '\u00A0\u2014 ')
}

export function tensionLabel(item: DialogListItemApiResponse): string | null {
  const { tensionBefore, tensionAfter } = item.summary ?? {}
  if (tensionBefore === null || tensionBefore === undefined) return null
  if (tensionAfter === null || tensionAfter === undefined) return `было ${tensionBefore}`
  return `${tensionBefore} → ${tensionAfter}`
}
