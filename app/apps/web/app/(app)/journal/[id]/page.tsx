import { redirect } from 'next/navigation'

export default async function OldJournalEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  redirect(`/diary/journal/${encodeURIComponent(id)}`)
}
