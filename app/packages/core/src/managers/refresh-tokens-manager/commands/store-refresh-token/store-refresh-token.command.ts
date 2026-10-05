import { RequestData } from 'mediatr-ts'
import type { StoreRefreshTokenCommandResult } from './store-refresh-token.types'

export interface StoreRefreshTokenCommandData {
  tokenId: string
  sessionId: string
  userId: string
  expiresAt: Date
  /** What the client says about itself; shown to the person in the list of their sessions. */
  clientId: string | null
  userAgent: string | null
}

export class StoreRefreshTokenCommand extends RequestData<StoreRefreshTokenCommandResult> {
  /** Survives minification: StoreRefreshTokenCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'StoreRefreshTokenCommand'

  public readonly tokenId: string
  public readonly sessionId: string
  public readonly userId: string
  public readonly expiresAt: Date
  public readonly clientId: string | null
  public readonly userAgent: string | null

  constructor(data: StoreRefreshTokenCommandData) {
    super()
    this.tokenId = data.tokenId
    this.sessionId = data.sessionId
    this.userId = data.userId
    this.expiresAt = data.expiresAt
    this.clientId = data.clientId
    this.userAgent = data.userAgent
  }
}
