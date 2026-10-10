import type { ReactNode } from 'react'

/**
 * Clicks inside are left out of click autocapture (the SDK skips an element and its descendants that
 * carry `ph-no-capture`). The text of a click is already cut before it is sent; this is the second
 * line, for screens where even the structure of a tap is about a person: a conversation, a journal
 * entry, the profile, the sign-in forms. `contents` keeps the wrapper out of the layout.
 */
export function NoCapture({ children }: { children: ReactNode }) {
  return <div className="ph-no-capture contents">{children}</div>
}
