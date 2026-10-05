'use client'

import type { ReactNode } from 'react'
import { AuthProvider } from '@/lib/auth'
import { NoticeProvider } from '@/components/Notice'
import { SosProvider } from '@/components/Sos'

/*
 * Radix (behind every shadcn dialog and sheet) locks the page scroll by injecting a <style> when a
 * dialog opens. Under the strict style-src that tag only runs with the page's nonce, and the bundled
 * helper looks for it in `__webpack_nonce__`, which Next does not fill. Scripts keep their nonce
 * property after the attribute is hidden, so it is read from there once, before any dialog can open.
 */
if (typeof document !== 'undefined') {
  const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce
  if (nonce) Object.assign(globalThis, { __webpack_nonce__: nonce })
}

/** Thin on purpose: the logic lives in lib/ and components/. */
export default function Providers({ apiBase, children }: { apiBase: string; children: ReactNode }) {
  return (
    <AuthProvider apiBase={apiBase}>
      <NoticeProvider>
        <SosProvider>{children}</SosProvider>
      </NoticeProvider>
    </AuthProvider>
  )
}
