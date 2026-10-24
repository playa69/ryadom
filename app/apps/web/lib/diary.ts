import { useCallback, useEffect, useRef, useState } from 'react'
import { WEB_DIARY_SEGMENT_KEY } from './storage-keys'

export type DiarySegment = 'diary' | 'recaps' | 'year' | 'tests'

export const DIARY_SEGMENTS: { key: DiarySegment; label: string; href: string }[] = [
  { key: 'diary', label: 'Дневник', href: '/diary' },
  { key: 'recaps', label: 'Итоги', href: '/diary/recaps' },
  { key: 'year', label: 'Год', href: '/diary/year' },
  { key: 'tests', label: 'Тесты', href: '/diary/tests' },
]

/** The segment the person left the diary in; the sidebar link and a bare `/diary` return to it. */
export function readLastSegment(): DiarySegment {
  try {
    const stored = window.localStorage.getItem(WEB_DIARY_SEGMENT_KEY)
    return DIARY_SEGMENTS.some((s) => s.key === stored) ? (stored as DiarySegment) : 'diary'
  } catch {
    return 'diary'
  }
}

export function writeLastSegment(segment: DiarySegment): void {
  try {
    window.localStorage.setItem(WEB_DIARY_SEGMENT_KEY, segment)
  } catch {
    // Private mode: the segment is simply not remembered.
  }
}

export const segmentHref = (segment: DiarySegment): string =>
  DIARY_SEGMENTS.find((s) => s.key === segment)?.href ?? '/diary'

/** Today's date on this device, `YYYY-MM-DD`: the day the cards treat as "today" and the future starts after. */
export function deviceToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: T }

/** Loads on mount and whenever `key` changes; `set` lets a card replace the data after its own write. */
export function useLoaded<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' })
  const loadRef = useRef(load)
  loadRef.current = load
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }))
    loadRef
      .current()
      .then((data) => !cancelled && setState({ status: 'ready', data }))
      .catch(() => !cancelled && setState({ status: 'error' }))
    return () => {
      cancelled = true
    }
  }, [key, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  const set = useCallback((update: (data: T) => T) => {
    setState((prev) => (prev.status === 'ready' ? { status: 'ready', data: update(prev.data) } : prev))
  }, [])
  return { state, reload, set }
}

/** Times a reminder may be set to: 08:00 to 22:30, every half hour. */
export const REMINDER_TIMES: string[] = Array.from({ length: 30 }, (_, i) => {
  const minutes = 8 * 60 + i * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})
