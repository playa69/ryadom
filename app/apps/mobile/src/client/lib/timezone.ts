import { Preferences } from '@capacitor/preferences'
import { deviceTimezone } from '@ryadom/client-core/diary'
import { updateProfile } from './api'

/**
 * The diary's day, the reminder and the weekly summary follow the person's time zone, and the server
 * does not know it unless the device says: sent when the app opens signed in, and again when the zone
 * changed (a trip). What was last sent is kept on the device, per account, so an unchanged zone costs nothing.
 */

const key = (userId: string) => `ryadom.timezone.${userId}`

export async function syncTimezone(userId: string, currentServerZone?: string): Promise<void> {
  const zone = deviceTimezone()
  if (!zone) return
  try {
    const { value } = await Preferences.get({ key: key(userId) })
    if (value === zone && (currentServerZone === undefined || currentServerZone === zone)) return
    await updateProfile({ timezone: zone })
    await Preferences.set({ key: key(userId), value: zone })
  } catch {
    // No network, or a zone the server does not know: tried again the next time the app opens.
  }
}
