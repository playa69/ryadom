import { closeDb } from '@ryadom/core/shared'

/**
 * Wiring for `@ryadom/core`. All domain logic lives in the core and the app server is a thin
 * layer: parse the request, call a core facade, translate the core code into a route code
 * (`switch` plus `assertNever`), map the response. Tokens (lib/jwt.ts) are the app's concern; the
 * core has no sessions.
 *
 * Core handlers are registered by importing its facades, which the routes do themselves, and the
 * core opens the database lazily from `DATABASE_URL`. Only closing the pool on shutdown is here.
 */
export async function shutdownCore(): Promise<void> {
  await closeDb()
}
