'use client'

import { useParams } from 'next/navigation'
import SharedDialogScreen from '@/components/SharedDialogScreen'

export default function SharedDialogPage() {
  const params = useParams<{ token: string }>()
  const token = typeof params.token === 'string' ? params.token : ''
  return <SharedDialogScreen key={token} token={token} />
}
