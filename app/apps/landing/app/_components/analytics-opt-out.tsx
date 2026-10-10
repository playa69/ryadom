'use client'

import { setAnalyticsOptOut } from '@ryadom/analytics/browser'
import { useAnalyticsOptOut } from '@ryadom/analytics/react'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'

/**
 * The visitor's way out of the statistics on this device. On means the site reports (the default); off
 * stops it at once and is remembered on the device. A person who later signs in to the app carries the
 * choice into the account (the app tells the server), so it is not undone by signing in.
 *
 * It is the same switch as the one in the profile of the app, which is the way out for an account;
 * this one exists because a visitor of the site has no profile to look in.
 */
export function AnalyticsOptOut() {
  const optedOut = useAnalyticsOptOut()
  return (
    <label className="flex cursor-pointer items-start gap-3" data-testid="analytics-opt-in">
      <NativeCheckbox checked={!optedOut} onChange={(event) => setAnalyticsOptOut(!event.target.checked)} />
      <span>Помогать улучшать «Рядом»: передавать обезличенные сведения об использовании на этом устройстве</span>
    </label>
  )
}
