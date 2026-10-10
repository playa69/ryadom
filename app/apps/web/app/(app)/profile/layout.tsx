import type { ReactNode } from 'react'
import { NoCapture } from '@/components/NoCapture'

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return <NoCapture>{children}</NoCapture>
}
