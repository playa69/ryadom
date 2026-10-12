'use client'

import { MessagesSquare } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useId, useMemo, useState } from 'react'
import type { DialogListItemApiResponse } from '@ryadom/contracts/api/dialogs'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { dialogMemoryMark } from '@ryadom/client-core/memory'
import { Alert } from '@ryadom/ui/components/alert'
import { Badge } from '@ryadom/ui/components/badge'
import { Button } from '@ryadom/ui/components/button'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { cn } from '@ryadom/ui/lib/utils'
import { useAuth } from '@/lib/auth'
import { formatJournalDate, tensionLabel, useJournal } from '@/lib/journal'
import { groupJournal } from '@/lib/journal-groups'
import { BUSY } from './busy'
import { BUTTON } from './controls'
import { BADGE_COMPACT, conversationHref, RetryButton, StatePanel } from './JournalParts'
import { Page, SECTION_HEADING } from './Page'

function entryTitle(item: DialogListItemApiResponse): string {
  return item.summary?.title || 'Разговор'
}

/*
 * The pane clips its rows to the rounded corners, so the keyboard ring is drawn inside the row: an
 * outer one would be cut off. The outline is on only while the row has keyboard focus, and transparent:
 * forced-colors mode paints it in a system color, and a permanent one would frame every row.
 */
const ROW_FOCUS =
  'outline-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-transparent focus-visible:inset-ring-2 focus-visible:inset-ring-ring'

function JournalRow({ item }: { item: DialogListItemApiResponse }) {
  const themes = item.summary?.themes.join(', ')
  const tension = tensionLabel(item)
  const memoryMark = dialogMemoryMark(item)
  return (
    <li className="border-b border-line last:border-b-0">
      {/* A real link, so "open in a new tab" works. */}
      <Link
        href={conversationHref(item)}
        prefetch={false}
        data-testid="journal-item"
        className={cn(
          // Phone: title, themes, then date and tension. From 700px the date and tension move to the right.
          'grid gap-x-6 gap-y-1 px-4 py-3.5 transition-colors hover:bg-white/5 tab:grid-cols-[minmax(0,1fr)_auto] tab:px-5',
          ROW_FOCUS,
        )}
      >
        <span className="line-clamp-2 text-base leading-snug font-semibold wrap-anywhere text-pretty text-foreground tab:col-start-1">
          {entryTitle(item)}
        </span>
        {themes && (
          <span className="line-clamp-2 text-[0.9375rem] leading-snug wrap-anywhere text-dim tab:col-start-1">
            {themes}
          </span>
        )}
        <span
          className={cn(
            'mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 tab:col-start-2 tab:row-start-1 tab:mt-0.5 tab:flex-col tab:items-end',
            themes && 'tab:row-span-2',
          )}
        >
          <time className="text-[0.8125rem] text-faint tabular-nums" dateTime={item.startedAt}>
            {formatJournalDate(item.startedAt)}
          </time>
          {!item.endedAt && (
            <Badge variant="soft" className={BADGE_COMPACT}>
              Не завершён
            </Badge>
          )}
          {memoryMark && (
            <Badge
              variant="outline"
              className={BADGE_COMPACT}
              title={memoryMark.hint}
              data-testid="journal-incognito"
            >
              {memoryMark.label}
              <span className="sr-only">. {memoryMark.hint}</span>
            </Badge>
          )}
          {tension && (
            <Badge variant="sage" className={cn(BADGE_COMPACT, 'font-bold')}>
              <span className="sr-only">Напряжение: </span>
              {tension}
            </Badge>
          )}
        </span>
      </Link>
    </li>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" role="status" aria-busy="true" data-testid="journal-loading">
      <span className="sr-only">Загружаем разговоры…</span>
      <Skeleton className="ml-1 h-3.5 w-20 motion-reduce:animate-none" />
      <div className="glass divide-y divide-line overflow-hidden rounded-lg" aria-hidden="true">
        {['w-2/3', 'w-1/2', 'w-3/5', 'w-1/2'].map((width, n) => (
          <div key={n} className="flex flex-col gap-2.5 px-4 py-4 tab:px-5">
            <Skeleton className={cn('h-4 motion-reduce:animate-none', width)} />
            <Skeleton className="h-3.5 w-1/3 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * All conversations: the whole history, grouped by day the same way as in the sidebar,
 * each row opening the conversation (a finished one read-only, an open one where it left off). The
 * agent stores the content and we only display it.
 */
export default function JournalScreen() {
  const idPrefix = useId()
  const { user } = useAuth()
  const { items, next, error, refresh, loadMore } = useJournal()
  // An account opened by this device alone: its history goes with the phone, or after the quiet period.
  const keepsConversations = user?.email === null || user?.isEmailConfirmed === false
  const [retrying, setRetrying] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [announced, setAnnounced] = useState(false)

  // A conversation may have ended in another tab since the list was loaded: refresh when this one is shown again.
  useEffect(() => {
    void refresh()
    const onShow = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('focus', onShow)
    return () => {
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('focus', onShow)
    }
  }, [refresh])

  async function retry() {
    setRetrying(true)
    await refresh()
    setRetrying(false)
  }

  async function showMore() {
    setLoadingMore(true)
    await loadMore()
    setLoadingMore(false)
    setAnnounced(true)
  }

  const groups = useMemo(() => groupJournal(items ?? []), [items])
  const isEmpty = items !== null && items.length === 0

  return (
    <Page title="Все разговоры" measure="reading" className="gap-8" data-testid="journal">
      {items === null && <ListSkeleton />}

      {isEmpty && (
        <StatePanel data-testid="journal-empty">
          {error ? (
            <>
              <p className="text-[0.9375rem] leading-[1.4] text-danger" role="alert" data-testid="form-error">
                {error}
              </p>
              <RetryButton busy={retrying} onClick={() => void retry()} />
            </>
          ) : (
            <>
              <MessagesSquare className="size-8 text-faint" strokeWidth={1.6} aria-hidden="true" />
              <p className="leading-[1.55] text-muted-foreground">Здесь появятся твои разговоры.</p>
              <Button asChild className={BUTTON}>
                <Link href="/home">Начать разговор</Link>
              </Button>
            </>
          )}
        </StatePanel>
      )}

      {items !== null && items.length > 0 && (
        <>
          {keepsConversations && (
            // The history is what a person has to lose, so this is where the address is offered. Where the
            // sidebar is a column it already carries the same card, and saying it twice is noise.
            <Alert
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 text-foreground md:hidden"
              data-testid="journal-link-email"
            >
              <span className="min-w-0 flex-1 basis-60">
                Разговоры хранятся только на этом устройстве, {ANONYMOUS_RETENTION_DAYS} дней после последнего
                визита. Привяжи почту, чтобы не потерять их.
              </span>
              <Button asChild variant="outline" size="sm" className={cn(BUTTON, 'border-input! px-4')}>
                <Link href="/profile?linkEmail=1">
                  {user?.email === null ? 'Привязать почту' : 'Подтвердить почту'}
                </Link>
              </Button>
            </Alert>
          )}

          {error && (
            // The button inside brings its own 44px of height, so the note itself takes little padding.
            <Alert
              variant="destructive"
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1 text-foreground"
              data-testid="journal-refresh-error"
            >
              <span>{error}</span>
              {/* A bare text link is one line high; as the note's only control it needs a touch target. */}
              <Button
                type="button"
                variant="link"
                size="sm"
                className={cn(BUTTON, BUSY, 'min-w-11 rounded-none px-0 underline-offset-[3px]')}
                aria-busy={retrying}
                onClick={() => void retry()}
              >
                Обновить
              </Button>
            </Alert>
          )}

          <div className="flex flex-col gap-7" data-testid="journal-list">
            {groups.map((group) => (
              // Not a <section>: a named section is a landmark, and one per day would bury the real ones.
              <div key={group.key} className="flex flex-col gap-2.5">
                <h2 id={`${idPrefix}-${group.key}`} className={SECTION_HEADING}>
                  {group.label}
                </h2>
                <ul className="glass overflow-hidden rounded-lg" aria-labelledby={`${idPrefix}-${group.key}`}>
                  {group.items.map((item) => (
                    <JournalRow key={item.dialogId} item={item} />
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {next && (
            <div className="flex justify-center">
              {/* Ignored while busy rather than disabled: keyboard focus stays on the button as the rows arrive. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(BUTTON, BUSY, 'px-5')}
                aria-busy={loadingMore}
                data-testid="journal-more"
                onClick={() => void showMore()}
              >
                Показать ещё
              </Button>
            </div>
          )}
          <p className="sr-only" role="status">
            {announced ? `Показано разговоров: ${items.length}` : ''}
          </p>

          <p className="px-1 text-[0.8125rem] leading-[1.45] text-faint">
            Аудио не сохраняется: разговор превращается в текст и остаётся только он. Стереть всё можно в
            профиле.
          </p>
        </>
      )}
    </Page>
  )
}
