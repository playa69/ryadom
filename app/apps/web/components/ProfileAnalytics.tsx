'use client'

import { useState } from 'react'
import { setAnalyticsOptOut } from '@ryadom/analytics/browser'
import { useAnalyticsOptOut } from '@ryadom/analytics/react'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { useClient } from '@/lib/auth'

/**
 * "Помогать улучшать «Рядом»": whether the app reports what it counts (taps, screens, how many
 * conversations reach the end). The switch is the inverse of the stored setting: on means reporting is
 * on. The choice is the account's: it is kept on the server, which then reports nothing about the
 * person from any device, and the browser follows it. One row of the settings list.
 *
 * Turning it off takes effect here at once and the account is told afterwards (a failure is retried at
 * the next sign-in). Turning it back on goes the other way round: the account first, and only when it
 * has agreed does this browser start reporting, so a failed call cannot leave the two disagreeing.
 */
export default function ProfileAnalytics() {
  const optedOut = useAnalyticsOptOut()
  const client = useClient()
  const [failed, setFailed] = useState(false)

  async function change(optOut: boolean) {
    setFailed(false)
    if (optOut) {
      setAnalyticsOptOut(true)
      await client.updateProfile({ analyticsOptOut: true }).catch(() => {})
      return
    }
    try {
      await client.updateProfile({ analyticsOptOut: false })
      setAnalyticsOptOut(false)
    } catch {
      setFailed(true)
    }
  }

  return (
    <li className="px-4 py-3">
      <label className="flex cursor-pointer items-start gap-3" data-testid="analytics-opt-in">
        <NativeCheckbox checked={!optedOut} onChange={(event) => void change(!event.target.checked)} />
        <span className="flex flex-col gap-1">
          <span className="text-base leading-[1.35] font-medium text-foreground">
            Помогать улучшать «Рядом»
          </span>
          <span className="text-[0.8125rem] leading-[1.45] text-dim">
            Мы собираем обезличенные сведения о том, как работает «Рядом»: какие экраны открывают, куда
            нажимают, где бывают ошибки. Имени, почты и того, что ты говоришь и пишешь, там нет. Выбор
            относится ко всему аккаунту, на всех твоих устройствах.
          </span>
          {failed && (
            <span role="alert" className="text-[0.8125rem] leading-[1.45] text-destructive">
              Не получилось включить. Попробуй чуть позже.
            </span>
          )}
        </span>
      </label>
    </li>
  )
}
