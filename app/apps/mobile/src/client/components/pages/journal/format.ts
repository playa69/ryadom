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

const SHARE_EXPIRY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })

/** "2 октября, 14:30": when a link to a conversation stops working. */
export function shareExpiryText(iso: string): string {
  return SHARE_EXPIRY.format(new Date(iso))
}

/** "0 просмотров", "1 просмотр", "3 просмотра". */
export function shareViewsText(count: number): string {
  const tail = count % 100
  const last = count % 10
  const word = tail >= 11 && tail <= 14 ? 'просмотров' : last === 1 ? 'просмотр' : last >= 2 && last <= 4 ? 'просмотра' : 'просмотров'
  return `${count} ${word}`
}
