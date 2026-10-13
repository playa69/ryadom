import { RequestData } from 'mediatr-ts'
import type { TrafficType } from '../../shared/user.dto'
import type { SetUserTrafficTypeCommandResult } from './set-user-traffic-type.types'

export interface SetUserTrafficTypeCommandData {
  userId: string
  trafficType: TrafficType
}

/**
 * Marks whose traffic an account is: `real` people, `test` (load tests, scripted checks) or `internal` (the team).
 * Product analytics tags every event of the account with it, so figures can leave out what is not people.
 */
export class SetUserTrafficTypeCommand extends RequestData<SetUserTrafficTypeCommandResult> {
  static readonly requestName = 'SetUserTrafficTypeCommand'

  public readonly userId: string
  public readonly trafficType: TrafficType

  constructor(data: SetUserTrafficTypeCommandData) {
    super()
    this.userId = data.userId
    this.trafficType = data.trafficType
  }
}
