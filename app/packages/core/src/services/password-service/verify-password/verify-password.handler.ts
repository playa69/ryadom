import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { verify } from '@node-rs/argon2'
import { createLogger } from '../../../shared'
import { VerifyPasswordRequest } from './verify-password.request'
import type { VerifyPasswordRequestResult } from './verify-password.types'

@requestHandler(VerifyPasswordRequest)
export class VerifyPasswordRequestHandler implements RequestHandler<VerifyPasswordRequest, VerifyPasswordRequestResult> {
  async handle(request: VerifyPasswordRequest): Promise<VerifyPasswordRequestResult> {
    try {
      return { isValid: await verify(request.passwordHash, request.password) }
    } catch (error) {
      // A corrupted hash in the database is no reason to break sign-in: treat the password as wrong
      // and write it to the log.
      createLogger('password-service').error('Stored password hash could not be verified', error)
      return { isValid: false }
    }
  }
}
