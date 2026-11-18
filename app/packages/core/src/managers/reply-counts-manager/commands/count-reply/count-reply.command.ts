import { RequestData } from 'mediatr-ts'
import type { CountReplyCommandResult } from './count-reply.types'

export interface CountReplyCommandData {
  userId: string
  /** When the gateway accepted the reply: it picks the day (in Moscow) the reply counts for. */
  at: Date
}

/** One more accepted reply of the person: for the goals of Yandex Metrika. */
export class CountReplyCommand extends RequestData<CountReplyCommandResult> {
  /** Survives minification: CountReplyCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'CountReplyCommand'

  public readonly userId: string
  public readonly at: Date

  constructor(data: CountReplyCommandData) {
    super()
    this.userId = data.userId
    this.at = data.at
  }
}
