/**
 * Notifications on the phone (`add-push-notifications`): a device that the person switched notifications on for
 * subscribes with the token its push service gave it, and unsubscribes when they are switched off or the person signs
 * out. A subscription belongs to the session it was made in. Adds routes and fields only.
 */

/** Push services a device subscribes through. Only RuStore Push (Android) for now. */
export const PUSH_CHANNELS = ['rustore'] as const
export type PushChannel = (typeof PUSH_CHANNELS)[number]

/** Keys of the `data` a notification carries to the app. Values are strings: push services take nothing else. */
export enum PushDataKey {
  /** A route of the app the tap opens (`/diary/`); anything else is ignored by the client. */
  Link = 'link',
}

export interface CreatePushSubscriptionApiRequest {
  channel: PushChannel
  /** The address the push service delivers to. A secret of the device: never log it. */
  token: string
  /** The push project the build was made for: the server sends with that project's service token. */
  projectId: string
  /** The package of the app (`ru.ryadom.companion`, `ru.ryadom.companion.dev`). */
  appId: string
}

export interface PushSubscriptionApiResponse {
  subscriptionId: string
}

export enum PushSubscriptionApiErrorCode {
  /** No subscription of this person has the id: it was removed already, and there is nothing left to do. */
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
  /** The account was deleted a moment ago. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}
