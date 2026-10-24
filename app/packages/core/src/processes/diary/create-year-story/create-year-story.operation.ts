import { RequestData } from 'mediatr-ts'
import type { CreateYearStoryResult } from './create-year-story.types'

export interface CreateYearStoryOperationData {
  userId: string
  year: number
  now?: Date
}

export class CreateYearStoryOperation extends RequestData<CreateYearStoryResult> {
  /** Survives build minification: CreateYearStoryOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CreateYearStoryOperation'

  public readonly userId: string
  public readonly year: number
  public readonly now?: Date

  constructor(data: CreateYearStoryOperationData) {
    super()
    this.userId = data.userId
    this.year = data.year
    this.now = data.now
  }
}
