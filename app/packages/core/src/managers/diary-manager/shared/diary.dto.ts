import type { DiarySummaryKind, DiarySummaryRow, MoodCheckinRow, MoodFactor, MoodSource } from '@ryadom/db/schema'

/** One note of the day; `date` is the person's local day, `YYYY-MM-DD`. */
export interface MoodCheckinDTO {
  date: string
  mood: number
  factor: MoodFactor | null
  source: MoodSource
  updatedAt: Date
}

/** The text of a week or a year, written by the agent and kept by the app. */
export interface DiarySummaryDTO {
  kind: DiarySummaryKind
  periodStart: string
  text: string
  stats: Record<string, unknown> | null
  generatedAt: Date
}

export function toMoodCheckinDTO(row: MoodCheckinRow): MoodCheckinDTO {
  return { date: row.localDate, mood: row.mood, factor: row.factor, source: row.source, updatedAt: row.updatedAt }
}

export function toDiarySummaryDTO(row: DiarySummaryRow): DiarySummaryDTO {
  return { kind: row.kind, periodStart: row.periodStart, text: row.text, stats: row.stats, generatedAt: row.generatedAt }
}
