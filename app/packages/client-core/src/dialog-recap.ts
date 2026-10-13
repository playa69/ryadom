/**
 * The closing sheet's recap: a sentence or two from the agent about what the conversation was about
 * and where it got to, put into "what you take with you" for the person to keep, edit or erase. Only
 * what they send with the end is kept.
 */

/** What became of the recap, for analytics: never the text, only whether it stayed as it was offered. */
export type RecapOutcome = 'none' | 'kept' | 'edited' | 'cleared'

/** `offered` is the recap that was put into the field (null if none was); `takeaway` is what is sent. */
export function recapOutcome(offered: string | null, takeaway: string | null): RecapOutcome {
  if (offered === null) return 'none'
  if (takeaway === null) return 'cleared'
  return takeaway === offered.trim() ? 'kept' : 'edited'
}

/**
 * Whether a recap that has just arrived goes into the field: while it is empty or still holds the
 * recap offered before, untouched (the sheet was opened again later in the conversation), but never
 * over the person's own words.
 */
export function takesRecap(field: string, offered: string | null): boolean {
  return field.trim() === '' || field === offered
}
