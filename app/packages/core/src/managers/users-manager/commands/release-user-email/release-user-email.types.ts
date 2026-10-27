export enum ReleaseUserEmailCommandErrorCode {
  /** The account no longer holds this address as an unconfirmed one: it was confirmed, replaced or taken off already. */
  ADDRESS_NOT_HELD = 'ADDRESS_NOT_HELD',
}

export type ReleaseUserEmailCommandResult =
  { success: true } | { success: false; error: ReleaseUserEmailCommandErrorCode }
