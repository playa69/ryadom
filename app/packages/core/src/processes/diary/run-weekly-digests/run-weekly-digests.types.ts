/**
 * `weeklyUserIds`: whose final week summary this pass made (one entry each).
 * The scheduler reports the fact to analytics from them; `weekly` is its length.
 */
export type RunWeeklyDigestsResult = {
  success: true
  weekly: number
  weeklyUserIds: string[]
}
