import type { Metadata } from 'next'
import DialogScreen from '@/components/DialogScreen'

export const metadata: Metadata = { title: 'Разговор' }

export default async function DialogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Keyed by id so a different dialog never inherits the previous one's feed or socket.
  return <DialogScreen key={id} dialogId={id} />
}
