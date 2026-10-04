'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * A countdown that starts at once and can be restarted. It counts against a deadline rather than
 * by decrementing once a second: a background tab throttles timers, and the person comes back
 * from the mail app to a countdown that must already be over.
 */
export function useCooldown(seconds: number): { remaining: number; restart(): void } {
  const [deadline, setDeadline] = useState(() => Date.now() + seconds * 1000)
  const [remaining, setRemaining] = useState(seconds)

  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [deadline])

  const restart = useCallback(() => setDeadline(Date.now() + seconds * 1000), [seconds])

  return { remaining, restart }
}
