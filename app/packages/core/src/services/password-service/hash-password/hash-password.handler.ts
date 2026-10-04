import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { hash } from '@node-rs/argon2'
import { HashPasswordRequest } from './hash-password.request'
import type { HashPasswordRequestResult } from './hash-password.types'
import { passwordConfig } from '../config'

@requestHandler(HashPasswordRequest)
export class HashPasswordRequestHandler implements RequestHandler<HashPasswordRequest, HashPasswordRequestResult> {
  async handle(request: HashPasswordRequest): Promise<HashPasswordRequestResult> {
    return { passwordHash: await hash(request.password, passwordConfig) }
  }
}
