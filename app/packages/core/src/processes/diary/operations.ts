import { RequestData } from 'mediatr-ts'
import type { MoodFactor, MoodSource } from '@ryadom/db/schema'
import type { DiarySummaryDTO, MoodCheckinDTO } from '../../managers/diary-manager'

export enum DiaryOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The date is neither today nor yesterday in the person's zone, or not a date at all. */
  DATE_OUT_OF_RANGE = 'DATE_OUT_OF_RANGE',
  NOT_ENOUGH_DAYS = 'NOT_ENOUGH_DAYS',
  NOT_ENOUGH_WEEKS = 'NOT_ENOUGH_WEEKS',
  /** The summary of this period was made less than a day ago. */
  TOO_SOON = 'TOO_SOON',
  /** The agent could not write the text. Nothing is stored and the limit is not spent. */
  SUMMARY_UNAVAILABLE = 'SUMMARY_UNAVAILABLE',
}

type Failure = { success: false; error: DiaryOperationErrorCode }

export interface ReminderState {
  enabled: boolean
  time: string
  paused: boolean
  offerAnswered: boolean
}

export interface DiaryView {
  today: MoodCheckinDTO | null
  month: MoodCheckinDTO[]
  week: { start: string; markedDays: number; summary: DiarySummaryDTO | null }
  reminder: ReminderState
}

export class GetDiaryOperation extends RequestData<{ success: true; diary: DiaryView } | Failure> {
  static readonly requestName = 'GetDiaryOperation'
  constructor(public readonly data: { userId: string; month?: string; now?: Date }) {
    super()
  }
}

export class PutMoodCheckinOperation extends RequestData<
  { success: true; checkin: MoodCheckinDTO; changed: boolean; hardStreak: number } | Failure
> {
  static readonly requestName = 'PutMoodCheckinOperation'
  constructor(
    public readonly data: {
      userId: string
      mood: number
      factor?: MoodFactor | null
      date?: string
      source: MoodSource
      now?: Date
    },
  ) {
    super()
  }
}

export interface YearView {
  year: number
  days: MoodCheckinDTO[]
  markedDays: number
  mostFrequent: number | null
  /** Final week summaries of the year so far. */
  weeklyCount: number
  story: { text: string; generatedAt: Date; weeklyCount: number } | null
}

export class GetYearOperation extends RequestData<{ success: true; year: YearView } | Failure> {
  static readonly requestName = 'GetYearOperation'
  constructor(public readonly data: { userId: string; year?: number; now?: Date }) {
    super()
  }
}

export class ListWeekSummariesOperation extends RequestData<
  { success: true; summaries: DiarySummaryDTO[]; nextBefore: string | null } | Failure
> {
  static readonly requestName = 'ListWeekSummariesOperation'
  constructor(public readonly data: { userId: string; before?: string }) {
    super()
  }
}

/** "Collect the week summary": the button, once a day, from 3 marked days. */
export class CreateWeekSummaryOperation extends RequestData<{ success: true; summary: DiarySummaryDTO } | Failure> {
  static readonly requestName = 'CreateWeekSummaryOperation'
  constructor(public readonly data: { userId: string; weekStart: string; now?: Date }) {
    super()
  }
}

export class CreateYearStoryOperation extends RequestData<{ success: true; summary: DiarySummaryDTO } | Failure> {
  static readonly requestName = 'CreateYearStoryOperation'
  constructor(public readonly data: { userId: string; year: number; now?: Date }) {
    super()
  }
}

export interface DiaryEvent {
  id: string
  text: string
  date: string
}

/** Notes of the week from the agent's memory (needs add-memory-notes); empty until the agent has them. */
export class GetDiaryEventsOperation extends RequestData<
  { success: true; memoryEnabled: boolean; events: DiaryEvent[] } | Failure
> {
  static readonly requestName = 'GetDiaryEventsOperation'
  constructor(public readonly data: { userId: string; weekStart?: string; now?: Date }) {
    super()
  }
}

/**
 * The scheduler's weekly job: for people whose local clock passed Monday 06:00, the finished week gets
 * its final summary (3 or more marked days), and the sixth final summary of the year brings the year
 * story. Idempotent: running it twice makes no second summary.
 */
export class RunWeeklyDigestsOperation extends RequestData<{ success: true; weekly: number; yearly: number }> {
  static readonly requestName = 'RunWeeklyDigestsOperation'
  constructor(public readonly data: { now?: Date; limit?: number } = {}) {
    super()
  }
}

/** Account deletion step: every diary table of the person. */
export class DeleteDiaryDataOperation extends RequestData<{ success: true }> {
  static readonly requestName = 'DeleteDiaryDataOperation'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}
