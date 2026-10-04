import type { DialogListItemApiResponse } from '@ryadom/contracts/api/dialogs'

export type JournalGroupKey = 'today' | 'yesterday' | 'week' | 'earlier'

export interface JournalGroup {
  key: JournalGroupKey
  label: string
  items: DialogListItemApiResponse[]
}

const LABELS: Record<JournalGroupKey, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  week: 'Последние 7 дней',
  earlier: 'Ранее',
}

const ORDER: JournalGroupKey[] = ['today', 'yesterday', 'week', 'earlier']

/**
 * Splits the conversations by calendar day (not by 24-hour windows: "yesterday" at 00:30 is still
 * yesterday evening). Each group keeps the order it came in, empty groups are left out, and an
 * unreadable date falls into "earlier" instead of vanishing.
 */
export function groupJournal(items: DialogListItemApiResponse[], now: Date = new Date()): JournalGroup[] {
  // Calendar arithmetic through the Date constructor, so a change of clocks cannot shift a boundary.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7).getTime()

  const buckets: Record<JournalGroupKey, DialogListItemApiResponse[]> = {
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
  }

  for (const item of items) {
    const started = new Date(item.startedAt).getTime()
    const key: JournalGroupKey = Number.isNaN(started)
      ? 'earlier'
      : started >= today
        ? 'today'
        : started >= yesterday
          ? 'yesterday'
          : started >= weekAgo
            ? 'week'
            : 'earlier'
    buckets[key].push(item)
  }

  return ORDER.filter((key) => buckets[key].length > 0).map((key) => ({
    key,
    label: LABELS[key],
    items: buckets[key],
  }))
}
