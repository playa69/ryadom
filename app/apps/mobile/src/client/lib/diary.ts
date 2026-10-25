import { Preferences } from '@capacitor/preferences'
import { useSyncExternalStore } from 'react'
import type {
  DiaryApiResponse,
  DiaryEventsApiResponse,
  DiaryYearApiResponse,
  MoodCheckinApi,
  MoodFactor,
  MoodLevel,
} from '@ryadom/contracts/api/diary'
import { weekStartOf } from '@ryadom/client-core/diary'
import { ApiError, NETWORK_ERROR_STATUS, apiErrorText, getDiary, getDiaryEvents, getDiaryYear, putMoodCheckin } from './api'
import {
  deviceDate,
  enqueueMark,
  parseQueue,
  removeMark,
  sendableMarks,
  type QueuedMark,
} from './diary-queue'

/**
 * The diary's data on screen: today's note, the last 28 days, the streak and the week. Module state like
 * the journal, so the segments share one read and a note made on the card shows on the chart at once.
 * The moods are the person's own: they live here and on the server, never in logs or analytics.
 */

const QUEUE_KEY = 'ryadom.diary.queue'
const SEGMENT_KEY = 'ryadom.diary.segment'

export type DiarySegment = 'diary' | 'recaps' | 'year'
export const SEGMENT_URLS: Record<DiarySegment, string> = {
  diary: '/diary/',
  recaps: '/diary/recaps/',
  year: '/diary/year/',
}

export async function rememberedSegment(): Promise<DiarySegment> {
  try {
    const { value } = await Preferences.get({ key: SEGMENT_KEY })
    return value && value in SEGMENT_URLS ? (value as DiarySegment) : 'diary'
  } catch {
    return 'diary'
  }
}

export function rememberSegment(segment: DiarySegment): void {
  void Preferences.set({ key: SEGMENT_KEY, value: segment }).catch(() => undefined)
}

export interface DiaryState {
  data: DiaryApiResponse | null
  loading: boolean
  /** Text for the screen; empty when all is well. */
  error: string
  /** Notes waiting for a network. */
  queued: number
}

const INITIAL: DiaryState = { data: null, loading: false, error: '', queued: 0 }
let state: DiaryState = INITIAL
const listeners = new Set<() => void>()
let generation = 0
let queue: QueuedMark[] = []
let queueLoaded: Promise<void> | null = null
let flushing = false

function update(patch: Partial<DiaryState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function loadQueue(): Promise<void> {
  queueLoaded ??= Preferences.get({ key: QUEUE_KEY })
    .then(({ value }) => {
      queue = parseQueue(value)
      update({ queued: queue.length })
    })
    .catch(() => undefined)
  await queueLoaded
}

async function saveQueue(next: QueuedMark[]): Promise<void> {
  queue = next
  update({ queued: next.length })
  try {
    if (next.length > 0) await Preferences.set({ key: QUEUE_KEY, value: JSON.stringify(next) })
    else await Preferences.remove({ key: QUEUE_KEY })
  } catch {
    // The queue then lives until the app is closed.
  }
}

const isNetworkError = (error: unknown): boolean => error instanceof ApiError && error.status === NETWORK_ERROR_STATUS

/** The note shown for today before the server has answered, and when it cannot. */
function withToday(
  data: DiaryApiResponse,
  date: string,
  mood: MoodLevel,
  factor: MoodFactor | null,
): DiaryApiResponse {
  const entry: MoodCheckinApi = { date, mood, factor }
  const inWeek = date >= data.week.start
  const wasMarked = data.recent.some((d) => d.date === date)
  // The window of the chart: the same note replaces the day, the oldest days stay as the server sent them.
  const recent = [...data.recent.filter((d) => d.date !== date), entry].sort((a, b) => a.date.localeCompare(b.date))
  const isToday = date === deviceDate()
  return {
    ...data,
    today: isToday ? { mood, factor } : data.today,
    recent,
    // A new note today continues the run that ended yesterday; a change of mind does not add a day.
    streak: isToday && !data.today ? data.streak + 1 : data.streak,
    week: { ...data.week, markedDays: data.week.markedDays + (inWeek && !wasMarked ? 1 : 0) },
  }
}

export const diary = {
  /** Reads the diary and sends what waited for a network. */
  async refresh(): Promise<void> {
    const started = generation
    await loadQueue()
    update({ loading: true })
    try {
      let data = await getDiary()
      if (started !== generation) return
      // Notes still waiting show as made: the server has not seen them yet.
      for (const mark of queue) data = withToday(data, mark.date, mark.mood, mark.factor)
      update({ data, error: '', loading: false })
      void diary.flush()
    } catch (error) {
      if (started !== generation) return
      update({ loading: false, error: apiErrorText(error, {}, 'Не получилось загрузить дневник') })
    }
  },

  /** Today's mood (and the factor, kept when the mood is changed). The choice shows at once. */
  async mark(mood: MoodLevel, factor: MoodFactor | null): Promise<void> {
    await loadQueue()
    const date = deviceDate()
    if (state.data) update({ data: withToday(state.data, date, mood, factor) })
    try {
      const outcome = await putMoodCheckin({ mood, factor, source: 'app' })
      if (outcome.ok) {
        // The server's answer wins over the guess: another device may have changed the day.
        await saveQueue(removeMark(queue, date))
        return
      }
      update({ error: 'Не получилось сохранить отметку' })
    } catch (error) {
      if (isNetworkError(error)) {
        await saveQueue(enqueueMark(queue, { date, mood, factor }))
        return
      }
      update({ error: apiErrorText(error, {}, 'Не получилось сохранить отметку') })
    }
  },

  /** Sends the notes made without a network, with the day they were made on. */
  async flush(): Promise<void> {
    await loadQueue()
    if (flushing || queue.length === 0) return
    flushing = true
    try {
      const today = deviceDate()
      const sendable = sendableMarks(queue, today)
      // Whatever is older than yesterday can no longer be written.
      await saveQueue(sendable)
      for (const mark of sendable) {
        try {
          await putMoodCheckin({ mood: mark.mood, factor: mark.factor, date: mark.date, source: 'app' })
          // Sent, or refused (the date is out of range): trying again would not change the answer.
          await saveQueue(removeMark(queue, mark.date))
        } catch (error) {
          if (isNetworkError(error)) break
          await saveQueue(removeMark(queue, mark.date))
        }
      }
    } finally {
      flushing = false
    }
  },

  /** On sign-in and sign-out: the next account must not see this one's notes. */
  reset(): void {
    generation += 1
    state = INITIAL
    queue = []
    queueLoaded = null
    flushing = false
    void Preferences.remove({ key: QUEUE_KEY }).catch(() => undefined)
    for (const listener of listeners) listener()
  },
}

export function useDiary(): DiaryState {
  return useSyncExternalStore(subscribe, () => state)
}

/** The week of the diary as `YYYY-MM-DD` of its Monday (the week the card shows). */
export const currentWeekStart = (): string => weekStartOf(deviceDate())

export function loadDiaryYear(year?: number): Promise<DiaryYearApiResponse> {
  return getDiaryYear(year)
}

export function loadDiaryEvents(week: string): Promise<DiaryEventsApiResponse> {
  return getDiaryEvents(week)
}

if (typeof window !== 'undefined') {
  // The connection is back: send what waited.
  window.addEventListener('online', () => void diary.flush())
}
