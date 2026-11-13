import {
  CountReplyCommand,
  GetReplyCountQuery,
  replyCountsManager,
} from '@ryadom/core/managers/reply-counts-manager'

/**
 * An accepted reply of the person, counted for the account: the dialog gateway's `reply_count` frame. The count and
 * its reading are two steps: two devices replying in the same instant may read the same number and lose a goal, which
 * is accepted for the simplicity. The first reply is the one that set `first_reply_at` to its own moment.
 */
export async function countReply(
  userId: string,
  at: Date,
): Promise<{ today: number; first: boolean } | null> {
  const counted = await replyCountsManager.execute(new CountReplyCommand({ userId, at }))
  if (!counted.success) return null
  const { count } = await replyCountsManager.execute(new GetReplyCountQuery({ userId }))
  if (!count) return null
  return { today: count.replies, first: count.firstReplyAt?.getTime() === at.getTime() }
}
