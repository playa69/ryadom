import type { SelfCheckResultRow, SelfCheckSubscale } from '@ryadom/db/schema'

/** One saved result: the score, the subscores, the level and the time; never the answers. */
export interface SelfCheckResultDTO {
  id: string
  testId: string
  testVersion: number
  score: number
  subscores: SelfCheckSubscale[] | null
  band: string
  takenAt: Date
}

export function toSelfCheckResultDTO(row: SelfCheckResultRow): SelfCheckResultDTO {
  return {
    id: row.id,
    testId: row.testId,
    testVersion: row.testVersion,
    score: row.score,
    subscores: row.subscores,
    band: row.band,
    takenAt: row.takenAt,
  }
}
