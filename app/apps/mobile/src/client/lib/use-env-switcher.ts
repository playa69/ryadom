import { useRef } from 'react'
import { ENV_SWITCHER_TAPS } from './env'
import { useAuth } from './store'

/**
 * Seven taps open the environment picker, dev build only. The
 * `import.meta.env.VITE_FLAVOR === 'dev'` check is spelled out inline as a
 * literal: in a production build it folds to `false`, so the minifier drops both
 * the handler and the switcher's dynamic import along with the local URLs.
 */
export function useEnvSwitcherTaps(): () => void {
  const taps = useRef(0)
  const lastTap = useRef(0)
  const { logout } = useAuth()

  return () => {
    if (import.meta.env.VITE_FLAVOR !== 'dev') return
    const now = Date.now()
    // A burst of taps, not seven random ones over a day.
    taps.current = now - lastTap.current > 1500 ? 1 : taps.current + 1
    lastTap.current = now
    if (taps.current < ENV_SWITCHER_TAPS) return
    taps.current = 0
    void import('./env-switcher').then(({ openEnvSwitcher }) => openEnvSwitcher(logout))
  }
}
