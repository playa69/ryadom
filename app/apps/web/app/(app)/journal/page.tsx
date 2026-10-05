import type { Metadata } from 'next'
import JournalScreen from '@/components/JournalScreen'

// The title sits on the page, not on a layout: a layout with its own title would stop the "— Рядом"
// template from reaching the title of /journal/[id] below it.
export const metadata: Metadata = { title: 'Все разговоры' }

export default function JournalPage() {
  return <JournalScreen />
}
