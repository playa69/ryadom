import {
  MOOD_FACTORS,
  MOOD_LEVELS,
  type MoodCheckinApi,
  type MoodFactor,
  type MoodLevel,
} from '@ryadom/contracts/api/diary'

/**
 * Pure helpers of the mood diary screens (`REQ-WELL-01`), shared by the mobile client and the web:
 * words, dates, the rolling chart, the year grid. Nothing here touches the network or the clock.
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

export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100
  const mod10 = n % 10
  if (mod100 >= 11 && mod100 <= 14) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
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

// ─── the rolling mood chart (last 28 days) ─────────────────────────────────────────────────────

const WEEKDAY_LETTERS = ['П', 'В', 'С', 'Ч', 'П', 'С', 'В'] as const

/** ISO weekday of a `YYYY-MM-DD` date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const { year, month, day } = parseDate(date)
  return ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1
}

/** One-letter weekday under the chart axis: П В С Ч П С В (Monday first). */
export function weekdayLetter(date: string): string {
  return WEEKDAY_LETTERS[isoWeekday(date) - 1]!
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = parseDate(from)
  const b = parseDate(to)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000)
}

/** `date` moved by `days` (negative goes back). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date)
  const moved = new Date(Date.UTC(year, month - 1, day + days))
  return toDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate())
}

/** How many days the chart shows at most, and the fewest columns it lays out. */
export const CHART_WINDOW_DAYS = 28
export const CHART_MIN_SLOTS = 7

export interface RollingChartSize {
  width: number
  height: number
  /** Space left and right of the columns. */
  padX?: number
  /** Space above the top level and below the bottom one inside `height`. */
  padY?: number
}

export interface RollingChartPoint {
  date: string
  /** Column index from the left, 0 = first day of the window. */
  slot: number
  x: number
  y: number
  mood: MoodLevel
  isToday: boolean
}

export interface RollingChartColumn {
  slot: number
  date: string
  /** Left edge and width of the column. */
  x: number
  width: number
  /** Saturday or Sunday: the column is shaded. Future columns are shaded too. */
  weekend: boolean
  /** The column is after today (the empty right part of a short window). */
  future: boolean
}

export interface RollingChartLabel {
  slot: number
  date: string
  /** Centre of the column. */
  x: number
  letter: string
  day: number
  /** The day number is written (every day up to 14 columns, every second one after; today always). */
  showDay: boolean
  isToday: boolean
}

export interface RollingChart {
  width: number
  height: number
  /** Columns laid out: 7 at least, 28 at most. */
  slots: number
  /** First date of the window and today. */
  start: string
  today: string
  columns: RollingChartColumn[]
  points: RollingChartPoint[]
  /** SVG path of the smooth line through the points; empty with fewer than two. */
  linePath: string
  /** SVG path of the area under the line down to the bottom level; empty with fewer than two points. */
  areaPath: string
  /** Labels of the days up to today (a future day has none). */
  labels: RollingChartLabel[]
  /** Faces on the left axis: top, middle and bottom level. */
  faces: { mood: 5 | 3 | 1; y: number }[]
  /** `октябрь`, or `сентябрь · октябрь` when the window spans two months. */
  header: string
  moodY: (mood: MoodLevel) => number
}

type Pt = { x: number; y: number }

/**
 * Smooth curve through the points that never leaves the band between neighbours (monotone cubic,
 * Fritsch–Carlson), so a sharp swing between «hard» and «great» does not overshoot the axis. Days
 * without a note are bridged: the line goes straight on across a gap.
 */
function monotonePath(points: readonly Pt[]): string {
  const n = points.length
  if (n < 2) return ''
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1]!.x - points[i]!.x)
    slope.push((points[i + 1]!.y - points[i]!.y) / dx[i]!)
  }
  const tangent: number[] = new Array<number>(n).fill(0)
  tangent[0] = slope[0]!
  tangent[n - 1] = slope[n - 2]!
  for (let i = 1; i < n - 1; i += 1) {
    tangent[i] = slope[i - 1]! * slope[i]! <= 0 ? 0 : (slope[i - 1]! + slope[i]!) / 2
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (slope[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const a = tangent[i]! / slope[i]!
    const b = tangent[i + 1]! / slope[i]!
    const h = Math.hypot(a, b)
    if (h > 3) {
      tangent[i] = (3 * a * slope[i]!) / h
      tangent[i + 1] = (3 * b * slope[i]!) / h
    }
  }
  const r = (v: number) => Math.round(v * 100) / 100
  let d = `M${r(points[0]!.x)} ${r(points[0]!.y)}`
  for (let i = 0; i < n - 1; i += 1) {
    const p = points[i]!
    const q = points[i + 1]!
    const third = dx[i]! / 3
    d += ` C${r(p.x + third)} ${r(p.y + tangent[i]! * third)} ${r(q.x - third)} ${r(q.y - tangent[i + 1]! * third)} ${r(q.x)} ${r(q.y)}`
  }
  return d
}

/**
 * The «Динамика настроения» chart: the last 28 days up to today, not a calendar month. The window
 * starts at the first note inside those 28 days (today when there is none) and has at least 7
 * columns, the free ones to the right are the days to come. Weekends are shaded, today is marked.
 */
export function buildRollingChart(
  recent: readonly MoodCheckinApi[],
  today: string,
  size: RollingChartSize,
): RollingChart {
  const { width, height, padX = 14, padY = 14 } = size
  const earliestAllowed = addDays(today, -(CHART_WINDOW_DAYS - 1))
  const inWindow = recent
    .filter((entry) => entry.date >= earliestAllowed && entry.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const start = inWindow[0]?.date ?? today
  const slots = Math.min(CHART_WINDOW_DAYS, Math.max(CHART_MIN_SLOTS, daysBetween(start, today) + 1))
  const step = (width - 2 * padX) / slots
  const moodY = (mood: MoodLevel) => padY + ((5 - mood) / 4) * (height - 2 * padY)
  const todaySlot = daysBetween(start, today)

  const columns: RollingChartColumn[] = []
  const labels: RollingChartLabel[] = []
  for (let slot = 0; slot < slots; slot += 1) {
    const date = addDays(start, slot)
    const future = slot > todaySlot
    columns.push({ slot, date, x: padX + slot * step, width: step, weekend: isoWeekday(date) >= 6, future })
    if (!future) {
      const isToday = slot === todaySlot
      // The number next to today's circle is left out so the two do not touch.
      const showDay = isToday || (slots <= 14 ? true : slot % 2 === 0 && slot !== todaySlot - 1)
      labels.push({
        slot,
        date,
        x: padX + (slot + 0.5) * step,
        letter: weekdayLetter(date),
        day: parseDate(date).day,
        showDay,
        isToday,
      })
    }
  }

  const points: RollingChartPoint[] = inWindow.map((entry) => {
    const slot = daysBetween(start, entry.date)
    return {
      date: entry.date,
      slot,
      x: padX + (slot + 0.5) * step,
      y: moodY(entry.mood),
      mood: entry.mood,
      isToday: entry.date === today,
    }
  })

  const linePath = monotonePath(points)
  const bottom = moodY(1)
  const areaPath =
    points.length < 2
      ? ''
      : `${linePath} L${Math.round(points[points.length - 1]!.x * 100) / 100} ${bottom} L${Math.round(points[0]!.x * 100) / 100} ${bottom} Z`

  const first = parseDate(start)
  const last = parseDate(today)
  const header =
    first.year === last.year && first.month === last.month
      ? monthName(last.month)
      : `${monthName(first.month)} · ${monthName(last.month)}`

  return {
    width,
    height,
    slots,
    start,
    today,
    columns,
    points,
    linePath,
    areaPath,
    labels,
    faces: [
      { mood: 5, y: moodY(5) },
      { mood: 3, y: moodY(3) },
      { mood: 1, y: moodY(1) },
    ],
    header,
    moodY,
  }
}

const FACTOR_SENTENCE: Record<MoodFactor, string> = {
  work: 'работа',
  people: 'близкие',
  health: 'здоровье',
  money: 'деньги',
  sleep: 'сон',
}

/**
 * The line under the chart about what weighs on the heavy days («Так себе» and «Тяжело»): the factor
 * named on most of them. Only with at least 3 heavy days and the factor on at least 2 of them;
 * a tie goes to the factor that comes first in the card's list. It states a count, never advice.
 */
export function moodInsight(recent: readonly Pick<MoodCheckinApi, 'mood' | 'factor'>[]): string | null {
  const heavy = recent.filter((entry) => entry.mood <= 2)
  if (heavy.length < 3) return null
  const counts = new Map<MoodFactor, number>()
  for (const entry of heavy) if (entry.factor) counts.set(entry.factor, (counts.get(entry.factor) ?? 0) + 1)
  let best: MoodFactor | null = null
  let bestCount = 0
  for (const factor of MOOD_FACTORS) {
    const count = counts.get(factor) ?? 0
    if (count > bestCount) {
      best = factor
      bestCount = count
    }
  }
  if (best === null || bestCount < 2) return null
  return `Тяжёлые дни чаще всего связаны с темой «${FACTOR_SENTENCE[best]}» (${bestCount} из ${heavy.length}).`
}
