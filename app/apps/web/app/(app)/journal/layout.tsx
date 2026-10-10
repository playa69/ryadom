import type { ReactNode } from 'react'
import { NoCapture } from '@/components/NoCapture'

// No `title` here: a layout with its own title would stop the "— Рядом" template from reaching the
// title of /journal/[id] (see page.tsx).
export default function JournalLayout({ children }: { children: ReactNode }) {
  return <NoCapture>{children}</NoCapture>
}
