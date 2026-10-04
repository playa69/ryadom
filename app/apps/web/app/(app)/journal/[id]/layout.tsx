import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = { title: 'Разговор' }

export default function JournalEntryLayout({ children }: { children: ReactNode }) {
  return children
}
