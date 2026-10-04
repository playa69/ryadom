'use client'

import { memo, useEffect, useRef, useState } from 'react'
import type { DialogMessageView } from '@ryadom/client-core/dialog-socket'
import { ChatMessage } from './ChatMessage'

/**
 * The message feed. Streaming text is deliberately not in a live region: announcing every delta
 * makes a screen reader stutter through half-sentences. A separate hidden region gets each
 * assistant message once, when it is complete.
 */
function DialogFeed({ messages }: { messages: DialogMessageView[] }) {
  const [announcement, setAnnouncement] = useState('')
  const announced = useRef(new Set<string>())

  useEffect(() => {
    const last = messages.findLast((message) => message.role === 'assistant')
    if (!last || last.streaming || !last.text || announced.current.has(last.id)) return
    announced.current.add(last.id)
    setAnnouncement(last.text)
  }, [messages])

  return (
    <>
      <ol className="flex flex-col gap-6" aria-label="Сообщения" data-testid="dialog-feed">
        {messages.map((message) => (
          <ChatMessage key={message.id} role={message.role} streaming={message.streaming} pending={message.pending}>
            {message.text}
          </ChatMessage>
        ))}
      </ol>
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="dialog-live">
        {announcement}
      </div>
    </>
  )
}

export default memo(DialogFeed)
