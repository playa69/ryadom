import { RequestData } from 'mediatr-ts'
import type { DeleteStalePushSubscriptionsCommandResult } from './delete-stale-push-subscriptions.types'

export interface DeleteStalePushSubscriptionsCommandData {
  now: Date
}

/** Housekeeping: subscriptions whose session has ended or expired are never sent to again. */
export class DeleteStalePushSubscriptionsCommand extends RequestData<DeleteStalePushSubscriptionsCommandResult> {
  /** Survives minification: DeleteStalePushSubscriptionsCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteStalePushSubscriptionsCommand'

  public readonly now: Date

  constructor(data: DeleteStalePushSubscriptionsCommandData) {
    super()
    this.now = data.now
  }
}
