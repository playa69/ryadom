import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { NoCapture } from '@/components/NoCapture'

// A link to someone's conversation is a secret in the address: it must not be indexed, and the
// address must not travel on in a Referer header.
export const metadata: Metadata = {
  title: 'Разговор',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function SharedDialogLayout({ children }: { children: ReactNode }) {
  return <NoCapture>{children}</NoCapture>
}
