'use client'

import { useEffect, useState } from 'react'

/** Thin on purpose: what was already loaded stays readable offline, so the notice takes little room. */
export default function OfflineBar() {
  // Starts true so server and first client render agree; the real value arrives in the effect.
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const sync = () => setOnline(navigator.onLine)
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  if (online) return null
  return (
    <div
      data-slot="offline-bar"
      // Sticks to the top of the page column, so it stays in view and pushes the header down.
      className="sticky top-0 z-40 border-b border-brand-line bg-surface-3 px-3 pt-[calc(env(safe-area-inset-top,0px)+6px)] pb-1.5 text-center text-[0.8125rem] font-semibold text-foreground"
      role="status"
    >
      Нет сети&nbsp;— линии помощи ниже работают всегда
    </div>
  )
}
