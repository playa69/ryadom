/**
 * The mood diary (`REQ-WELL-01`, `openspec/changes/add-mood-diary`). One mood note per person per
 * local day; the day is the one in the person's time zone (`MeApiResponse.timezone`). The values are
 * health-adjacent: they go to the person's own screens and, as codes, to the agent for the summary,
 * never to product analytics.
 */

/** Five levels, from "hard" (1) to "great" (5). */
export const MOOD_LEVELS = [1, 2, 3, 4, 5] as const
export type MoodLevel = (typeof MOOD_LEVELS)[number]

/** What most affected the mood: work, people close by, health, money, sleep. */
export const MOOD_FACTORS = ['work', 'people', 'health', 'money', 'sleep'] as const
export type MoodFactor = (typeof MOOD_FACTORS)[number]

/** Where a mood note was made. */
export const MOOD_SOURCES = ['app', 'widget', 'reminder', 'telegram'] as const
export type MoodSource = (typeof MOOD_SOURCES)[number]

/** Marked days a week needs before "Week summary" can be made. */
export const WEEK_SUMMARY_MIN_DAYS = 3
/** Week summaries a year story needs; "Add more" appears after this many more. */
export const YEAR_STORY_MIN_WEEKS = 6
export const YEAR_STORY_EXTEND_WEEKS = 4
/** Days back a note without network may be written for (the offline queue). */
export const MOOD_BACKFILL_MAX_DAYS = 7
/** After 3 days of "hard" in a row the bridge to the conversation says more. */
export const MOOD_HARD_STREAK_DAYS = 3

export enum DiaryApiErrorCode {
  /** Fewer marked days in the week than `WEEK_SUMMARY_MIN_DAYS`. */
  NOT_ENOUGH_DAYS = 'NOT_ENOUGH_DAYS',
  /** Fewer week summaries than `YEAR_STORY_MIN_WEEKS`. */
  NOT_ENOUGH_WEEKS = 'NOT_ENOUGH_WEEKS',
  /** The summary of this period was made less than a day ago. */
  TOO_SOON = 'TOO_SOON',
  /** The date is in the future or older than `MOOD_BACKFILL_MAX_DAYS`. */
  DATE_OUT_OF_RANGE = 'DATE_OUT_OF_RANGE',
  /** The agent could not write the text; try again later. */
  SUMMARY_UNAVAILABLE = 'SUMMARY_UNAVAILABLE',
}

export interface MoodCheckinApi {
  /** `YYYY-MM-DD` in the person's time zone. */
  date: string
  mood: MoodLevel
  factor: MoodFactor | null
}

export interface DiarySummaryApi {
  kind: 'week' | 'year'
  /** `YYYY-MM-DD`: Monday of the week, or 1 January of the year. */
  periodStart: string
  text: string
  generatedAt: string
}

/** `GET /api/diary?month=YYYY-MM` (the current month by default). */
export interface DiaryApiResponse {
  today: { mood: MoodLevel; factor: MoodFactor | null } | null
  month: MoodCheckinApi[]
  week: { start: string; markedDays: number; summary: DiarySummaryApi | null }
}

/** `PUT /api/diary/checkins/today`: save or replace; `date` is for the offline queue only. */
export interface PutMoodCheckinApiRequest {
  mood: MoodLevel
  factor?: MoodFactor | null
  date?: string
  source?: MoodSource
}

export interface PutMoodCheckinApiResponse {
  checkin: MoodCheckinApi
  /** A note for this day existed and was replaced. */
  changed: boolean
  /** Days of "hard" in a row ending with this one, for the bridge to the conversation. */
  hardStreak: number
}

/** `GET /api/diary/year?year=2026`. */
export interface DiaryYearApiResponse {
  year: number
  days: MoodCheckinApi[]
  markedDays: number
  mostFrequent: MoodLevel | null
  /** Final week summaries of the year so far. */
  weeklyCount: number
  /** `weeklyCount` is how many week summaries the text was written from: "Add more" needs four more. */
  story: { text: string; generatedAt: string; weeklyCount: number } | null
}

/** `GET /api/diary/summaries?kind=week&before=<periodStart>`, newest first. */
export interface DiarySummariesApiResponse {
  items: DiarySummaryApi[]
  nextBefore: string | null
}

/** `POST /api/diary/summaries/week`. */
export interface CreateWeekSummaryApiRequest {
  /** `YYYY-MM-DD`, Monday. */
  weekStart: string
}

/** `POST /api/diary/summaries/year`. */
export interface CreateYearStoryApiRequest {
  year: number
}

/** `GET /api/diary/events?week=<weekStart>`: notes of the week from the agent's memory. */
export interface DiaryEventsApiResponse {
  /** Memory is off or has no notes: the client shows the empty state. */
  memoryEnabled: boolean
  items: { id: string; text: string; date: string }[]
}

/** `POST /api/diary/widget-token` (the token is shown once) and `DELETE` to revoke. */
export interface WidgetTokenApiResponse {
  token: string
}

/** `GET /api/diary/widget/today`, with `Authorization: Widget <token>` only. */
export interface WidgetTodayApiResponse {
  today: { mood: MoodLevel; factor: MoodFactor | null } | null
}

/** `PUT /api/diary/widget/checkin`, with `Authorization: Widget <token>` only. */
export interface WidgetCheckinApiRequest {
  mood: MoodLevel
  factor?: MoodFactor | null
  date?: string
}
