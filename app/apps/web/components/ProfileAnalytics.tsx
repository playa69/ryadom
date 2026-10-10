'use client'

import { setAnalyticsOptOut } from '@ryadom/analytics/browser'
import { useAnalyticsOptOut } from '@ryadom/analytics/react'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'

/**
 * "Помогать улучшать «Рядом»": whether this browser reports what the app counts (taps, screens, how
 * many conversations reach the end). The switch is the inverse of the stored setting: on means
 * reporting is on, and turning it off takes effect at once and stays. It belongs to this browser, not
 * the account. One row of the settings list.
 */
export default function ProfileAnalytics() {
  const optedOut = useAnalyticsOptOut()

  return (
    <li className="px-4 py-3">
      <label className="flex cursor-pointer items-start gap-3" data-testid="analytics-opt-in">
        <NativeCheckbox checked={!optedOut} onChange={(event) => setAnalyticsOptOut(!event.target.checked)} />
        <span className="flex flex-col gap-1">
          <span className="text-base leading-[1.35] font-medium text-foreground">
            Помогать улучшать «Рядом»
          </span>
          <span className="text-[0.8125rem] leading-[1.45] text-dim">
            Мы считаем нажатия и числа — например, сколько разговоров дошло до конца. Что ты говоришь и
            пишешь, в эту статистику не попадает никогда. Только в этом браузере.
          </span>
        </span>
      </label>
    </li>
  )
}
