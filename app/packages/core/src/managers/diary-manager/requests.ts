import { RequestData } from 'mediatr-ts'
import type { DiarySummaryKind, MoodFactor, MoodSource } from '@ryadom/db/schema'

/** What the diary tables hold, in the shape the processes use. Dates are `YYYY-MM-DD` strings. */
export interface MoodCheckinDTO {
  date: string
  mood: number
  factor: MoodFactor | null
  source: MoodSource
  updatedAt: Date
}

export interface DiarySummaryDTO {
  kind: DiarySummaryKind
  periodStart: string
  text: string
  stats: Record<string, unknown> | null
  generatedAt: Date
}

export class UpsertMoodCheckinCommand extends RequestData<{ success: true; checkin: MoodCheckinDTO; changed: boolean }> {
  static readonly requestName = 'UpsertMoodCheckinCommand'
  constructor(
    public readonly data: {
      userId: string
      localDate: string
      mood: number
      /** undefined keeps the factor already set for the day; null clears it. */
      factor?: MoodFactor | null
      source: MoodSource
    },
  ) {
    super()
  }
}

export class ListMoodCheckinsQuery extends RequestData<{ success: true; checkins: MoodCheckinDTO[] }> {
  static readonly requestName = 'ListMoodCheckinsQuery'
  constructor(public readonly data: { userId: string; from: string; to: string }) {
    super()
  }
}

export class UpsertDiarySummaryCommand extends RequestData<{ success: true; summary: DiarySummaryDTO }> {
  static readonly requestName = 'UpsertDiarySummaryCommand'
  constructor(
    public readonly data: {
      userId: string
      kind: DiarySummaryKind
      periodStart: string
      text: string
      stats: Record<string, unknown> | null
      generatedAt: Date
    },
  ) {
    super()
  }
}

export class ListDiarySummariesQuery extends RequestData<{ success: true; summaries: DiarySummaryDTO[] }> {
  static readonly requestName = 'ListDiarySummariesQuery'
  constructor(
    public readonly data: {
      userId: string
      kind: DiarySummaryKind
      /** Only periods strictly before this date. */
      before?: string
      /** Only periods inside `[from, to]`. */
      from?: string
      to?: string
      limit?: number
    },
  ) {
    super()
  }
}

/** Account deletion: marks, summaries, settings, subscriptions, deliveries and widget tokens go. */
export class DeleteUserDiaryCommand extends RequestData<{ success: true }> {
  static readonly requestName = 'DeleteUserDiaryCommand'
  constructor(public readonly data: { userId: string }) {
    super()
  }
}
