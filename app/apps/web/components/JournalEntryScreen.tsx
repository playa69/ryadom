'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { DialogApiErrorCode, type DialogApiResponse } from '@ryadom/contracts/api/dialogs'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { Button } from '@ryadom/ui/components/button'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { useJournal } from '@/lib/journal'
import { BUTTON } from './controls'
import JournalEntry from './JournalEntry'
import { RetryButton, StatePanel } from './JournalParts'
import { Page } from './Page'

const ENTRY_UNAVAILABLE = 'Разговор недоступен'

const ENTRY_ERROR_TEXT: Record<DialogApiErrorCode, string> = {
  [DialogApiErrorCode.DIALOG_NOT_FOUND]: 'Этот разговор не найден',
  [DialogApiErrorCode.USER_NOT_FOUND]: ENTRY_UNAVAILABLE,
  [DialogApiErrorCode.USER_INACTIVE]: ENTRY_UNAVAILABLE,
}

type Load =
  | { status: 'loading' }
  /** `retryable`: the request itself failed (offline, a server error). A refusal will not change on a retry. */
  | { status: 'error'; text: string; retryable: boolean }
  | { status: 'ready'; dialog: DialogApiResponse }

function EntrySkeleton() {
  return (
    <div className="flex flex-col gap-8" role="status" aria-busy="true">
      <span className="sr-only">Открываем разговор…</span>
      <div className="flex flex-col gap-8" aria-hidden="true">
        <Skeleton className="h-20 w-full rounded-lg motion-reduce:animate-none" />
        <div className="flex flex-col gap-6">
          <Skeleton className="ml-auto h-11 w-3/5 rounded-3xl motion-reduce:animate-none" />
          <div className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full motion-reduce:animate-none" />
            <div className="flex flex-1 flex-col gap-2.5 pt-1.5">
              <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
            </div>
          </div>
          <Skeleton className="ml-auto h-11 w-2/5 rounded-3xl motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  )
}

/**
 * One past conversation as its own page: the header with the way back and the title, then the
 * read-only transcript. Mount with `key={dialogId}`, so a different conversation starts from the
 * loading state.
 */
export default function JournalEntryScreen({ dialogId }: { dialogId: string }) {
  const client = useClient()
  const { items } = useJournal()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    client
      .getDialog(dialogId)
      .then((result) => {
        if (cancelled) return
        setLoad(
          result.ok
            ? { status: 'ready', dialog: result.data }
            : {
                status: 'error',
                text: codeText(ENTRY_ERROR_TEXT, result.code, ENTRY_UNAVAILABLE),
                retryable: false,
              },
        )
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoad({
            status: 'error',
            text: apiErrorText(err, {}, 'Не получилось открыть разговор'),
            retryable: true,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, dialogId, attempt])

  function retry() {
    setLoad({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  const dialog = load.status === 'ready' ? load.dialog : null
  // The title comes from the list row while the transcript loads, so the heading does not flash "Разговор".
  const head = dialog ?? items?.find((item) => item.dialogId === dialogId) ?? null

  return (
    <Page
      title={head?.summary?.title || 'Разговор'}
      back={{ href: '/journal', label: 'Все разговоры' }}
      measure="reading"
      className="gap-8"
      data-testid="journal-entry"
      aria-busy={load.status === 'loading'}
    >
      {load.status === 'loading' && <EntrySkeleton />}

      {load.status === 'error' && (
        <StatePanel data-testid="journal-entry-error">
          <p className="text-[0.9375rem] leading-[1.4] text-danger" role="alert" data-testid="form-error">
            {load.text}
          </p>
          {load.retryable ? (
            <RetryButton onClick={retry} />
          ) : (
            <Button asChild variant="outline" size="sm" className={cn(BUTTON, 'px-4')}>
              <Link href="/journal">К списку разговоров</Link>
            </Button>
          )}
        </StatePanel>
      )}

      {dialog && <JournalEntry dialog={dialog} />}
    </Page>
  )
}
