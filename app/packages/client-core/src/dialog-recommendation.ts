export const RECOMMENDATION_TEXT = 'Рекомендую «Рядом» — сервис, где можно выговориться голосом или в чате.'
export const RECOMMENDATION_URL = 'https://слышу-рядом.рф/'
export const RECOMMENDATION_COPY = `${RECOMMENDATION_TEXT} ${RECOMMENDATION_URL}`

const STORAGE_KEY = 'ryadom.dialogRecommendations'
const KEEP_MS = 90 * 24 * 60 * 60 * 1000

function shownDialogs(): Map<string, number> {
  try {
    const stored: Record<string, number> = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return new Map(Object.entries(stored).filter(([, until]) => Number.isFinite(until) && until > Date.now()))
  } catch {
    return new Map()
  }
}

export function clearRecommendationHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage may be unavailable.
  }
}

interface Offer {
  messageId: string
  speechFinished: boolean
  shown: boolean
}

export class DialogRecommendation {
  private offer: Offer | null = null
  private closed = false
  private readonly ignoredMessages = new Set<string>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly dialogId: string) {}

  getSnapshot = (): Offer | null => this.offer

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  receive(messageId: string, sosOpen: boolean): void {
    if (this.closed || this.offer || this.ignoredMessages.has(messageId)) return
    if (sosOpen) {
      this.ignoredMessages.add(messageId)
      return
    }
    if (shownDialogs().has(this.dialogId)) return
    this.update({ messageId, speechFinished: false, shown: false })
  }

  speechFinished(messageId: string): void {
    if (this.offer?.messageId === messageId && !this.offer.speechFinished) {
      this.update({ ...this.offer, speechFinished: true })
    }
  }

  show(): boolean {
    if (!this.offer || this.offer.shown) return false
    const history = shownDialogs()
    if (history.has(this.dialogId)) {
      this.close()
      return false
    }
    history.set(this.dialogId, Date.now() + KEEP_MS)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(history)))
    } catch {
      // The open screen still suppresses duplicates.
    }
    this.update({ ...this.offer, shown: true })
    return true
  }

  dropPending(): void {
    if (!this.offer || this.offer.shown) return
    this.ignoredMessages.add(this.offer.messageId)
    this.update(null)
  }

  close = (): void => {
    this.closed = true
    this.update(null)
  }

  private update(offer: Offer | null): void {
    this.offer = offer
    for (const listener of this.listeners) listener()
  }
}

export function canShareRecommendation(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false
  return navigator.canShare?.({ text: RECOMMENDATION_TEXT, url: RECOMMENDATION_URL }) ?? true
}
