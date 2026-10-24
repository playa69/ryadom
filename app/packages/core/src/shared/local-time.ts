/**
 * The person's local day, week and clock (`REQ-WELL-01`, design D5). Everything is computed from a
 * `Date` and an IANA zone, so tests move time by passing another `Date`.
 */

export interface LocalMoment {
  /** `YYYY-MM-DD` in the zone. */
  date: string
  /** Minutes since local midnight. */
  minutes: number
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  isoWeekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    formatters.set(timeZone, f)
  }
  return f
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

export function localMoment(now: Date, timeZone: string): LocalMoment {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(now).map((p) => [p.type, p.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    isoWeekday: WEEKDAYS[parts.weekday!] ?? 1,
  }
}

export function addDaysToDate(date: string, days: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + days))
  return next.toISOString().slice(0, 10)
}

/** Monday of the ISO week the date falls in. */
export function weekStart(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  const weekday = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1
  return addDaysToDate(date, 1 - weekday)
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
}

/** `HH:mm` or `HH:mm:ss` → minutes since midnight. */
export function timeToMinutes(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number)
  return h * 60 + m
}

export function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
