import {
  MOOD_FACTORS,
  MOOD_LEVELS,
  type MoodCheckinApi,
  type MoodFactor,
  type MoodLevel,
} from '@ryadom/contracts/api/diary'

/**
 * Pure helpers of the mood diary screens (`REQ-WELL-01`), shared by the mobile client and the web:
 * words, dates, the month chart, the year grid. Nothing here touches the network or the clock.
 */

export const MOOD_LABELS: Record<MoodLevel, string> = {
  1: 'Тяжело',
  2: 'Так себе',
  3: 'Нормально',
  4: 'Хорошо',
  5: 'Отлично',
}

export const FACTOR_LABELS: Record<MoodFactor, string> = {
  work: 'Работа',
  people: 'Близкие',
  health: 'Здоровье',
  money: 'Деньги',
  sleep: 'Сон',
}

export { MOOD_FACTORS, MOOD_LEVELS }

/** CSS colour of a level: the `--ryadom-mood-N` token, with a fallback for a page without the design tokens. */
export const MOOD_COLORS: Record<MoodLevel, string> = {
  1: '#e5645f',
  2: '#ee9a55',
  3: '#e9d36b',
  4: '#86cf86',
  5: '#4ec5d9',
}
export const moodColor = (mood: MoodLevel): string => `var(--ryadom-mood-${mood}, ${MOOD_COLORS[mood]})`

const MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]
const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]
const MONTHS_PREPOSITIONAL = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
]

export const monthName = (month: number): string => MONTHS_NOMINATIVE[month - 1] ?? ''

/** `2026-10-19` → `{ year, month, day }`. */
export function parseDate(date: string): { year: number; month: number; day: number } {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number)
  return { year, month, day }
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const toDate = (year: number, month: number, day: number): string => `${year}-${pad(month)}-${pad(day)}`
export const toMonthKey = (year: number, month: number): string => `${year}-${pad(month)}`

/** `19 октября`. */
export function longDate(date: string): string {
  const { month, day } = parseDate(date)
  return `${day} ${MONTHS_GENITIVE[month - 1] ?? ''}`
}

/** `19 октября — нормально · Работа`: what a tap on a year cell says. */
export function dayCaption(entry: MoodCheckinApi): string {
  const factor = entry.factor ? ` · ${FACTOR_LABELS[entry.factor]}` : ''
  return `${longDate(entry.date)} — ${MOOD_LABELS[entry.mood].toLowerCase()}${factor}`
}

/** The most frequent level of the notes; a tie goes to the higher level. Null without notes. */
export function mostFrequentMood(days: readonly Pick<MoodCheckinApi, 'mood'>[]): MoodLevel | null {
  const counts = new Map<MoodLevel, number>()
  for (const { mood } of days) counts.set(mood, (counts.get(mood) ?? 0) + 1)
  let best: MoodLevel | null = null
  let bestCount = 0
  for (const level of MOOD_LEVELS) {
    const count = counts.get(level) ?? 0
    if (count > 0 && count >= bestCount) {
      best = level
      bestCount = count
    }
  }
  return best
}

/** The text alternative of the month chart for a screen reader. */
export function chartAlt(year: number, month: number, days: readonly MoodCheckinApi[]): string {
  const name = MONTHS_PREPOSITIONAL[month - 1] ?? ''
  if (days.length === 0) return `В ${name} отметок пока нет`
  const top = mostFrequentMood(days)
  return `В ${name} отмечено ${days.length} ${plural(days.length, 'день', 'дня', 'дней')}, чаще всего — ${MOOD_LABELS[top ?? 3].toLowerCase()}`
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

export interface ChartPoint {
  day: number
  mood: MoodLevel
  x: number
  y: number
}

export interface ChartGeometry {
  width: number
  height: number
  points: ChartPoint[]
  /** Runs of neighbouring days: a missing day breaks the line. */
  segments: ChartPoint[][]
  /** x of each day of the month, for the axis. */
  dayX: (day: number) => number
  moodY: (mood: MoodLevel) => number
}

/** Month chart: days along x, five levels along y (5 on top). A gap in the days breaks the line. */
export function buildChart(
  year: number,
  month: number,
  days: readonly MoodCheckinApi[],
  size: { width: number; height: number; padX?: number; padY?: number },
): ChartGeometry {
  const { width, height, padX = 14, padY = 14 } = size
  const count = daysInMonth(year, month)
  const dayX = (day: number) => padX + ((day - 1) / Math.max(count - 1, 1)) * (width - 2 * padX)
  const moodY = (mood: MoodLevel) => padY + ((5 - mood) / 4) * (height - 2 * padY)
  const byDay = new Map<number, MoodLevel>()
  for (const entry of days) {
    const parsed = parseDate(entry.date)
    if (parsed.year === year && parsed.month === month) byDay.set(parsed.day, entry.mood)
  }
  const points: ChartPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, mood]) => ({ day, mood, x: dayX(day), y: moodY(mood) }))
  const segments: ChartPoint[][] = []
  for (const point of points) {
    const current = segments[segments.length - 1]
    if (current && current[current.length - 1]!.day === point.day - 1) current.push(point)
    else segments.push([point])
  }
  return { width, height, points, segments, dayX, moodY }
}

export interface YearCell {
  date: string
  day: number
  entry: MoodCheckinApi | null
  future: boolean
}

/** 12 rows of months; each row holds only the days the month has (no 31 February). */
export function buildYearGrid(
  year: number,
  days: readonly MoodCheckinApi[],
  today: string,
): YearCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  return Array.from({ length: 12 }, (_, m) =>
    Array.from({ length: daysInMonth(year, m + 1) }, (_, d) => {
      const date = toDate(year, m + 1, d + 1)
      return { date, day: d + 1, entry: byDate.get(date) ?? null, future: date > today }
    }),
  )
}

/** Monday of the ISO week of a `YYYY-MM-DD` date. */
export function weekStartOf(date: string): string {
  const { year, month, day } = parseDate(date)
  const d = new Date(Date.UTC(year, month - 1, day))
  const shift = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - shift)
  return toDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** The device's IANA zone, for `PATCH /api/auth/me { timezone }`. Null where the runtime cannot say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/** The line of the bridge to the conversation; null for a day that needs none. */
export function bridgeFor(mood: MoodLevel, hardStreak: number): 'talk' | 'hard-streak' | null {
  if (mood === 1 && hardStreak >= 3) return 'hard-streak'
  return mood <= 2 ? 'talk' : null
}
