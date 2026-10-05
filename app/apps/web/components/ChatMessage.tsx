import type { ReactNode } from 'react'
import { Orb } from '@ryadom/ui/components/orb'
import { cn } from '@ryadom/ui/lib/utils'

export type ChatRole = 'user' | 'assistant'

/**
 * One message of a conversation, as a chat app draws it: the person's own lines in a soft bubble on
 * the right, the companion's words as plain text on the left beside a small sphere that breathes
 * while the answer is still arriving. The live dialog and the read-only transcript share it, so a
 * conversation looks the same before and after it ends.
 *
 * Renders an `li`: put it inside an `ol`. `data-testid` and `data-role` are what the e2e suite reads.
 */
export function ChatMessage({
  role,
  children,
  streaming = false,
  pending = false,
  className,
}: {
  role: ChatRole
  children: ReactNode
  /** The answer is still being written: the sphere breathes and a caret follows the text. */
  streaming?: boolean
  /** The message has not been acknowledged by the server yet. */
  pending?: boolean
  className?: string
}) {
  return (
    <li
      data-testid="dialog-message"
      data-role={role}
      className={cn(
        'flex min-w-0 gap-3 data-[role=user]:justify-end',
        pending && 'opacity-70',
        className,
      )}
    >
      {role === 'assistant' && <Orb animated={streaming} className="mt-0.5 size-8" />}
      <p
        data-streaming={streaming ? 'true' : undefined}
        className={cn(
          // The person's own line breaks (Shift+Enter) and the agent's paragraphs must survive.
          'min-w-0 text-base leading-[1.65] wrap-anywhere whitespace-pre-wrap',
          role === 'user'
            ? 'max-w-[85%] rounded-3xl rounded-br-lg border border-line bg-white/8 px-4 py-2.5 text-foreground'
            : 'flex-1 pt-1 text-pretty text-foreground',
          // The caret has an empty alternative text, so a screen reader does not read it out.
          "data-streaming:after:ml-0.5 data-streaming:after:animate-blink data-streaming:after:text-brand-400 data-streaming:after:content-['▋'_/_''] motion-reduce:data-streaming:after:animate-none",
        )}
      >
        <span className="sr-only">{role === 'user' ? 'Ты: ' : 'Рядом: '}</span>
        {children}
        {pending && <span className="sr-only"> (отправляется)</span>}
      </p>
    </li>
  )
}
