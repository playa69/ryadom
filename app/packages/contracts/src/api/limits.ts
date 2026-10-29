/**
 * Input rules the routes check themselves before the core (a violation is a 422) and the screens
 * check before sending, so that the person learns about them sooner than the server does.
 */
export enum InputLimit {
  PasswordMin = 8,
  PasswordMax = 128,
  /** The name is 1 to 64 characters after trimming whitespace. */
  NameMax = 64,
  /** The code from the email is exactly six digits. */
  CodeLength = 6,
  /** One message in a dialog. */
  MessageMax = 4000,
  /** The "what you take with you" field on the closing screen. */
  TakeawayMax = 500,
  /**
   * A note the person corrects (`PATCH /api/memory/facts/:id`). The agent itself is stricter and answers `FACT_REJECTED` with
   * `too_long`.
   */
  MemoryFactMax = 200,
}
