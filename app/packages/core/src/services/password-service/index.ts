// 1. Handler imports
import './hash-password/hash-password.handler'
import './verify-password/verify-password.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { HashPasswordRequest } from './hash-password/hash-password.request'
export type { HashPasswordRequestData } from './hash-password/hash-password.request'
export { VerifyPasswordRequest } from './verify-password/verify-password.request'
export type { VerifyPasswordRequestData } from './verify-password/verify-password.request'

// 3. Type re-exports
export type { HashPasswordRequestResult } from './hash-password/hash-password.types'
export type { VerifyPasswordRequestResult } from './verify-password/verify-password.types'

// 4. Union type
import type { HashPasswordRequest } from './hash-password/hash-password.request'
import type { VerifyPasswordRequest } from './verify-password/verify-password.request'

export type PasswordServiceRequests =
  | HashPasswordRequest
  | VerifyPasswordRequest

// 5. Facade
export class PasswordService implements IPasswordService {
  async execute<T extends PasswordServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: PasswordServiceRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IPasswordService {
  execute<T extends PasswordServiceRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const passwordService: IPasswordService = new PasswordService()
