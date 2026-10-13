import type { Metadata } from 'next'
import ProfileMemory from '@/components/ProfileMemory'

export const metadata: Metadata = { title: 'Память' }

export default function MemoryPage() {
  return <ProfileMemory />
}
