/** The count of an account: its latest day in Moscow, replies on that day, and when its first reply was accepted. */
export interface ReplyCountDTO {
  day: string
  replies: number
  /** Null for an account that existed before the count: its first reply was never seen. */
  firstReplyAt: Date | null
}

/** `count: null` — the account has no reply counted yet. */
export type GetReplyCountQueryResult = { success: true; count: ReplyCountDTO | null }
