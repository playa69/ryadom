import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = { title: 'Люди рядом' }

export default function PeopleLayout({ children }: { children: ReactNode }) {
  return children
}
