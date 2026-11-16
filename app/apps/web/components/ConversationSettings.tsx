'use client'

import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@ryadom/ui/lib/utils'
import { FOCUS_RING } from './controls'

/**
 * The collapsed "Настроить разговор" block of the home screen: the optional memory choice folds in
 * here, so the message field and the voice start stay the main actions. A native details/summary —
 * collapsed by default and reachable by keyboard and screen readers without extra state.
 */
export default function ConversationSettings({ children }: { children: ReactNode }) {
  return (
    <details className="group w-full max-w-md" data-testid="home-settings">
      <summary
        className={cn(
          FOCUS_RING,
          'flex min-h-11 cursor-pointer list-none items-center justify-center gap-1.5 rounded-sm text-sm text-dim outline-none hover:text-foreground [&::-webkit-details-marker]:hidden',
        )}
      >
        Настроить разговор
        <Plus aria-hidden="true" className="size-4 transition-transform group-open:rotate-45" />
      </summary>
      <div className="flex flex-col items-center gap-4 pt-1">{children}</div>
    </details>
  )
}
