/** Wording for a link to a conversation (`REQ-DATA-05`): the date it ends and how often it was opened. */

const EXPIRY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false })

/** "2 октября, 14:30". */
export function shareExpiryText(iso: string): string {
  return EXPIRY.format(new Date(iso))
}

/** "0 просмотров", "1 просмотр", "3 просмотра". */
export function shareViewsText(count: number): string {
  const tail = count % 100
  const last = count % 10
  const word = tail >= 11 && tail <= 14 ? 'просмотров' : last === 1 ? 'просмотр' : last >= 2 && last <= 4 ? 'просмотра' : 'просмотров'
  return `${count} ${word}`
}
