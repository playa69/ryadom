/**
 * `weeklyUserIds` / `yearlyUserIds`: whose final week summary / year story this pass made (one entry each).
 * The scheduler reports the fact to analytics from them; the counts are their lengths.
 */
export type RunWeeklyDigestsResult = {
  success: true
  weekly: number
  yearly: number
  weeklyUserIds: string[]
  yearlyUserIds: string[]
}
