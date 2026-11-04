import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, validateInput } from '../../../shared'
import { auditLogManager, RecordAuditLogEntryCommand } from '../../../managers/audit-log-manager'
import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '../../../managers/users-manager'
import {
  ListActivePushSubscriptionsQuery,
  pushSubscriptionsManager,
} from '../../../managers/push-subscriptions-manager'
import { deliver } from '../shared/deliver'
import { SendUserNotificationOperation } from './send-user-notification.operation'
import {
  SendUserNotificationOperationErrorCode,
  type SendUserNotificationResult,
} from './send-user-notification.types'
import { sendUserNotificationSchema } from './send-user-notification.validator'

/**
 * An admin writes to one person from their card: the notification goes to every device of theirs with notifications
 * on, in a session that is still open, all at once. The audit entry holds what was sent and how many devices took it,
 * and is written after the sending: the push service cannot be part of a transaction, and an entry is wanted whatever
 * it answered.
 */
@requestHandler(SendUserNotificationOperation)
export class SendUserNotificationOperationHandler implements RequestHandler<
  SendUserNotificationOperation,
  SendUserNotificationResult
> {
  async handle(operation: SendUserNotificationOperation): Promise<SendUserNotificationResult> {
    const message = validateInput(sendUserNotificationSchema, {
      title: operation.title,
      body: operation.body,
      link: operation.link,
    })

    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: SendUserNotificationOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: SendUserNotificationOperationErrorCode.USER_DELETED }

    const { subscriptions } = await pushSubscriptionsManager.execute(
      new ListActivePushSubscriptionsQuery({ userId: user.id, now: new Date() }),
    )
    const outcomes = await Promise.all(subscriptions.map((subscription) => deliver(subscription, message)))
    const sent = outcomes.filter((outcome) => outcome === 'sent').length
    const total = subscriptions.length

    await auditLogManager.execute(
      new RecordAuditLogEntryCommand({
        entryId: randomUUID(),
        adminEmail: operation.adminEmail,
        action: 'USER_NOTIFICATION_SENT',
        targetUserId: user.id,
        targetEmail: user.email,
        payload: { title: message.title, body: message.body, sent, total },
      }),
    )
    createLogger('notifications').info('Notification sent to a user by an admin', {
      userId: user.id,
      sent,
      total,
    })
    return { success: true, sent, total }
  }
}
