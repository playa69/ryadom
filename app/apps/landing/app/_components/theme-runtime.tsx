'use client'

import { useEffect } from 'react'
import { applyTheme, scheduledTheme, themeBoundaryDelay } from '@/lib/theme'

/**
 * Keeps an open page on the theme schedule without a reload: re-applies at every 07:00/22:00
 * boundary and re-checks when the tab comes back (a suspended tab can sleep through a boundary).
 * A manual choice stops both from moving the palette until the next manual change, while the
 * boundary timer itself keeps running, so an opened-overnight tab still lands on schedule.
 */
export function ThemeRuntime() {
  useEffect(() => {
    // The boot script already set this pre-paint; applying again costs nothing and covers a tab
    // restored from a cache whose clock has moved since the HTML was produced.
    applyTheme(scheduledTheme())
    let timer = 0
    const arm = () => {
      timer = window.setTimeout(() => {
        applyTheme(scheduledTheme())
        arm()
      }, themeBoundaryDelay())
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') applyTheme(scheduledTheme())
    }
    arm()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  return null
}
