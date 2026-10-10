import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Icon } from 'framework7-react'
import { useEffect, useState } from 'react'
import { isOnline, onNetworkChange } from '../lib/native'

/**
 * Offline bar. Deliberately not a half-screen sheet: whatever was already loaded is still
 * readable offline, so the notice must not take up more room than the outage itself.
 */
export default function OfflineBar() {
  const [online, setOnline] = useState(isOnline)

  useEffect(() => onNetworkChange(setOnline), [])

  // Each time the bar appears.
  useEffect(() => {
    if (!online) track(AnalyticsEvent.OfflineShown)
  }, [online])

  if (online) return null
  return (
    <div className="rd-offline" role="status">
      <Icon f7="wifi_slash" size={16} />
      <span>Нет сети&nbsp;— линии помощи ниже работают всегда</span>
    </div>
  )
}
