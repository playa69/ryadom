'use client'

import { Lock } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { SharedDialogApiResponse } from '@ryadom/contracts/api/dialog-shares'
import type { SharedDialogResult } from '@ryadom/client-core/client'
import { Button } from '@ryadom/ui/components/button'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { shareExpiryText } from '@/lib/dialog-share'
import { formatJournalDate } from '@/lib/journal'
import { Wordmark } from './Brand'
import { BUTTON } from './controls'
import { ChatMessage } from './ChatMessage'

type Load = { status: 'loading' } | SharedDialogResult

/**
 * What a link to a conversation opens (`REQ-DATA-05`): the transcript, read-only, for someone who
 * may not have the app or an account. No summary, no tension, no controls. A link that does not work
 * says so in one way whatever the reason (expired, revoked, deleted): the screen cannot tell them
 * apart, and neither can the server's answer.
 */
export default function SharedDialogScreen({ token }: { token: string }) {
  const client = useClient()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    client.getSharedDialog(token).then((result) => {
      if (!cancelled) setLoad(result)
    })
    return () => {
      cancelled = true
    }
  }, [client, token, attempt])

  return (
    <div className="flex min-h-dvh flex-col" data-testid="shared-dialog">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-bars px-4 pt-[env(safe-area-inset-top,0px)] box-content">
        <Wordmark className="text-xl" />
        <span className="text-[0.8125rem] text-faint">Только чтение</span>
      </header>
      <main className="mx-auto w-full max-w-180 flex-1 px-4 pt-6 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] tab:px-6 tab:pt-10">
        {load.status === 'loading' && (
          <div className="flex flex-col gap-6" role="status" aria-busy="true">
            <span className="sr-only">Открываем разговор…</span>
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="ml-auto h-11 w-3/5 rounded-3xl" />
            <Skeleton className="h-11 w-4/5 rounded-3xl" />
          </div>
        )}

        {load.status === 'gone' && (
          <div className="flex flex-col items-center gap-3 pt-16 text-center" data-testid="shared-gone">
            <Lock aria-hidden="true" className="size-9 text-faint" />
            <h1 className="text-xl font-bold tracking-display">Ссылка больше не действует</h1>
            <p className="max-w-sm text-[0.9375rem] leading-[1.5] text-dim">
              Срок истёк, ссылку отозвали или разговор удалён. Попроси отправителя создать новую.
            </p>
          </div>
        )}

        {load.status === 'unavailable' && (
          <div className="flex flex-col items-center gap-4 pt-16 text-center" data-testid="shared-unavailable">
            <h1 className="text-xl font-bold tracking-display">Не получилось открыть</h1>
            <p className="max-w-sm text-[0.9375rem] leading-[1.5] text-dim">Попробуй ещё раз чуть позже.</p>
            <Button variant="outline" className={BUTTON} onClick={() => { setLoad({ status: 'loading' }); setAttempt((n) => n + 1) }}>
              Повторить
            </Button>
          </div>
        )}

        {load.status === 'ok' && <Transcript dialog={load.dialog} />}
      </main>
    </div>
  )
}

function Transcript({ dialog }: { dialog: SharedDialogApiResponse }) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">Разговор</h1>
      <p
        className="rounded-lg border border-sage/30 bg-sage/10 px-4 py-3 text-[0.9375rem] leading-[1.5] text-sage"
        data-testid="shared-banner"
      >
        С тобой поделились разговором от {formatJournalDate(dialog.startedAt)}.
        {dialog.isOpen && <> Он ещё шёл, показано на {formatJournalDate(dialog.sharedAt)}.</>} Ссылка действует до{' '}
        {shareExpiryText(dialog.expiresAt)}.
      </p>
      <ol className="flex flex-col gap-6" aria-label="Текст разговора" data-testid="shared-messages">
        {dialog.messages.map((message, index) => (
          <ChatMessage key={index} role={message.role}>
            {message.text}
          </ChatMessage>
        ))}
      </ol>
      <div className={cn('flex flex-col items-center gap-3 border-t border-line pt-8 text-center')}>
        <p className="text-[0.8125rem] text-faint">Ты видишь только этот разговор.</p>
        <Button asChild variant="outline" size="sm" className={cn(BUTTON, 'px-4')}>
          <Link href="/">Что такое «Рядом»</Link>
        </Button>
      </div>
    </div>
  )
}
