import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { NoCapture } from '@/components/NoCapture'

export const metadata: Metadata = { title: 'Дневник' }

/** Moods and summaries are about a person: the structure of a tap is not reported (`ph-no-capture`). */
export default function DiaryLayout({ children }: { children: ReactNode }) {
  return <NoCapture>{children}</NoCapture>
}
