import type { Algorithm, Options } from '@node-rs/argon2'

/** argon2id with OWASP parameters: 19 MiB of memory, 2 passes, 1 thread. */
export const passwordConfig: Options = {
  // Algorithm is a const enum in the package types: under isolatedModules we pass the numeric value
  // (2 = Argon2id).
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
}
