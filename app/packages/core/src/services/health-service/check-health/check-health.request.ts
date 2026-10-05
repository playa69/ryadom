import { RequestData } from 'mediatr-ts'
import type { CheckHealthRequestResult } from './check-health.types'

export type CheckHealthRequestData = Record<string, never>

export class CheckHealthRequest extends RequestData<CheckHealthRequestResult> {
  /** Survives build minification: CheckHealthRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'CheckHealthRequest'

  constructor(_data: CheckHealthRequestData = {}) {
    super()
  }
}
