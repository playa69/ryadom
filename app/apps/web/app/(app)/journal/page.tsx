import { redirect } from 'next/navigation'

// The journal lives inside the diary (`/diary/journal`); old links and bookmarks keep working.
export default function OldJournalPage() {
  redirect('/diary/journal')
}
