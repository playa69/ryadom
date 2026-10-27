import type { Metadata } from 'next'
import type { ReactNode } from 'react'

// The diary layout above sets its own title, which drops the root template, so the suffix is written out.
export const metadata: Metadata = { title: { absolute: 'Разговор — Рядом' } }

export default function JournalEntryLayout({ children }: { children: ReactNode }) {
  return children
}
