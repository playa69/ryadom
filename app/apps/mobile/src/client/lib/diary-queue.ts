import type { MoodFactor, MoodLevel } from '@ryadom/contracts/api/diary'

/**
 * Mood notes made without a network. A note waits on the device and goes up when the connection
 * is back, with the day it was made on: the server takes today or yesterday of the person's zone,
 * so a note older than that is dropped (the diary has no entries written afterwards).
 * Pure functions: the storage is in diary.ts.
 */

export interface QueuedMark {
  /** `YYYY-MM-DD` on the device when the note was made. */
  date: string
  mood: MoodLevel
  factor: MoodFactor | null
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The date on the device's clock, which follows the person's zone (the app reports it to the server). */
export function deviceDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function previousDate(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() - 1)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** A new choice for a day replaces the queued one: the last one wins, as it does on the server. */
export function enqueueMark(queue: readonly QueuedMark[], mark: QueuedMark): QueuedMark[] {
  return [...queue.filter((m) => m.date !== mark.date), mark].sort((a, b) => a.date.localeCompare(b.date))
}

/** What may still be sent: today and yesterday. */
export function sendableMarks(queue: readonly QueuedMark[], today: string): QueuedMark[] {
  const yesterday = previousDate(today)
  return queue.filter((m) => m.date === today || m.date === yesterday)
}

export function removeMark(queue: readonly QueuedMark[], date: string): QueuedMark[] {
  return queue.filter((m) => m.date !== date)
}

export function parseQueue(raw: string | null): QueuedMark[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter(
      (m): m is QueuedMark =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as QueuedMark).date === 'string' &&
        [1, 2, 3, 4, 5].includes((m as QueuedMark).mood),
    )
  } catch {
    return []
  }
}
