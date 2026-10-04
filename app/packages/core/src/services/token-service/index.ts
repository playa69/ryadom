// 1. Handler imports
import './hash-token/hash-token.handler'
import './create-numeric-code/create-numeric-code.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { HashTokenRequest } from './hash-token/hash-token.request'
export type { HashTokenRequestData } from './hash-token/hash-token.request'
export { CreateNumericCodeRequest } from './create-numeric-code/create-numeric-code.request'
export type { CreateNumericCodeRequestData } from './create-numeric-code/create-numeric-code.request'

// 3. Type re-exports
export type { HashTokenRequestResult } from './hash-token/hash-token.types'
export type { CreateNumericCodeRequestResult } from './create-numeric-code/create-numeric-code.types'

// 4. Union type
import type { HashTokenRequest } from './hash-token/hash-token.request'
import type { CreateNumericCodeRequest } from './create-numeric-code/create-numeric-code.request'

export type TokenServiceRequests =
  | HashTokenRequest
  | CreateNumericCodeRequest

// 5. Facade
export class TokenService implements ITokenService {
  async execute<T extends TokenServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: TokenServiceRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface ITokenService {
  execute<T extends TokenServiceRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const tokenService: ITokenService = new TokenService()
