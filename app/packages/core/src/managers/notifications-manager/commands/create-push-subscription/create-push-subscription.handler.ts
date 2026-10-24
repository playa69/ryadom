import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { sql } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { CreatePushSubscriptionCommand } from './create-push-subscription.command'
import { type CreatePushSubscriptionCommandResult } from './create-push-subscription.types'

@requestHandler(CreatePushSubscriptionCommand)
export class CreatePushSubscriptionCommandHandler implements RequestHandler<CreatePushSubscriptionCommand, CreatePushSubscriptionCommandResult> {
  async handle(c: CreatePushSubscriptionCommand): Promise<CreatePushSubscriptionCommandResult> {
    // The caller made the id, and repeats with the same id refresh the row: a new key pair, the failures forgotten.
    await getDb()
      .insert(pushSubscriptions)
      .values({
        id: c.id,
        userId: c.userId,
        channel: c.channel,
        endpoint: c.endpoint ?? null,
        p256dh: c.p256dh ?? null,
        auth: c.auth ?? null,
        deviceLabel: c.deviceLabel ?? null,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.id,
        set: {
          userId: c.userId,
          p256dh: c.p256dh ?? null,
          auth: c.auth ?? null,
          deviceLabel: sql`coalesce(${c.deviceLabel ?? null}, ${pushSubscriptions.deviceLabel})`,
          failures: 0,
        },
      })
    return { success: true }
  }
}
