'use client'

import { useParams } from 'next/navigation'
import JournalEntryScreen from '@/components/JournalEntryScreen'

export default function JournalEntryPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  return <JournalEntryScreen key={id} dialogId={id} />
}
