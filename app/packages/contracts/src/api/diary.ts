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
/** Minutes between two manual re-runs of the week text. */
export const MANUAL_REFRESH_COOLDOWN_MIN = 10
/** Days back a note without network may be written for (the offline queue): today and yesterday. */
export const MOOD_BACKFILL_MAX_DAYS = 1
/** After 3 days of "hard" in a row the bridge to the conversation says more. */
export const MOOD_HARD_STREAK_DAYS = 3

export enum DiaryApiErrorCode {
  /** Fewer marked days in the week than `WEEK_SUMMARY_MIN_DAYS`. */
  NOT_ENOUGH_DAYS = 'NOT_ENOUGH_DAYS',
  /** The text of this week was re-run by hand less than `MANUAL_REFRESH_COOLDOWN_MIN` minutes ago (or is being written). */
  TOO_SOON = 'TOO_SOON',
  /** The agent could not write the text; try again later. */
  SUMMARY_UNAVAILABLE = 'SUMMARY_UNAVAILABLE',
  /** The date is in the future or older than `MOOD_BACKFILL_MAX_DAYS` days. */
  DATE_OUT_OF_RANGE = 'DATE_OUT_OF_RANGE',
}

export interface MoodCheckinApi {
  /** `YYYY-MM-DD` in the person's time zone. */
  date: string
  mood: MoodLevel
  factor: MoodFactor | null
}

export interface DiarySummaryApi {
  kind: 'week'
  /** `YYYY-MM-DD`: Monday of the week. */
  periodStart: string
  text: string
  generatedAt: string
  /** Days of «Тяжело» in the week the text was written for; with 3 or more the text ends with a soft line about people nearby. */
  hardDays: number
}

/** The mood chart shows this many days up to and including today. */
export const MOOD_CHART_DAYS = 28

/** `GET /api/diary`. */
export interface DiaryApiResponse {
  today: { mood: MoodLevel; factor: MoodFactor | null } | null
  /** Notes of the last `MOOD_CHART_DAYS` days including today: the window of the mood chart. */
  recent: MoodCheckinApi[]
  /**
   * Consecutive marked days ending today, or ending yesterday while today is not marked yet; 0 when
   * neither is marked. A plain counter «🔥 N дн.» in the mood card header, nothing more (`REQ-WELL-01`).
   */
  streak: number
  week: { start: string; markedDays: number; summary: DiarySummaryApi | null }
  /** The final summary of the last finished week (closed by the scheduler), or null while it has none. */
  previousWeek: DiarySummaryApi | null
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

/** `POST /api/diary/summaries/week`: re-run the text of the current week now («Обновить итоги»). */
export interface CreateWeekSummaryApiRequest {
  /** `YYYY-MM-DD`, Monday of the current week. */
  weekStart: string
}

/** `GET /api/diary/summaries?kind=week&before=<periodStart>`, newest first. */
export interface DiarySummariesApiResponse {
  items: DiarySummaryApi[]
  nextBefore: string | null
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
