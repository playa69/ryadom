import {
  GetNotificationSettingsQuery,
  ListPushSubscriptionsQuery,
  notificationsManager,
  type NotificationSettingsDTO,
  type PushSubscriptionDTO,
} from '../../../managers/notifications-manager'

export interface SettingsView {
  settings: NotificationSettingsDTO
  subscriptions: PushSubscriptionDTO[]
}

export async function readSettingsView(userId: string): Promise<SettingsView> {
  const [settings, subs] = await Promise.all([
    notificationsManager.execute(new GetNotificationSettingsQuery({ userId })),
    notificationsManager.execute(new ListPushSubscriptionsQuery({ userId })),
  ])
  return { settings: settings.settings, subscriptions: subs.subscriptions }
}
