'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import {
  MEMORY_FACT_ERRORS,
  MEMORY_FORGET_ERRORS,
  memoryFactChange,
  type MemoryCardItem,
} from '@ryadom/client-core/memory'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import { useAuth, useClient } from '@/lib/auth'
import { memoryCard, pendingForgets, useMemoryCard, usePendingForgets } from '@/lib/memory'
import { BUTTON, FOCUS_RING } from './controls'
import { NoCapture } from './NoCapture'
import { useNotice } from './Notice'

/**
 * "Я запомнил": after a conversation with memory, what it added, two to four points, each with
 * "убрать" (and "Запомнить" for one that waits for the person's answer). It appears on home once the
 * agent has finished, and only if there is something to show: nothing is said when there is not.
 * The texts are the person's words: the card is out of click autocapture (`NoCapture`), and only the
 * kind of tap is reported.
 */

const ACTION = cn(BUTTON, 'h-8 px-3 text-sm')

export default function MemoryCard() {
  const client = useClient()
  const notify = useNotice()
  const { user } = useAuth()
  const card = useMemoryCard(user?.id ?? null)
  const pending = usePendingForgets()
  const [busyId, setBusyId] = useState<string | null>(null)
  if (!card) return null

  /** "убрать": the same five seconds to take it back as on the screen "Память". */
  function dismiss(item: MemoryCardItem) {
    const { id } = item.fact
    pendingForgets.schedule(id, async () => {
      try {
        const result = await client.forgetMemoryFact(id)
        if (!result.ok) {
          notify(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось убрать'), 'error')
          return
        }
        track(AnalyticsEvent.MemoryCardAction, { action: 'dismiss_item' })
        memoryCard.remove(id)
      } catch (err) {
        notify(apiErrorText(err, {}, 'Не получилось убрать'), 'error')
      }
    })
  }

  async function accept(item: MemoryCardItem) {
    setBusyId(item.fact.id)
    try {
      const result = await client.updateMemoryFact(item.fact.id, memoryFactChange('accept'))
      if (!result.ok) {
        notify(codeText(MEMORY_FACT_ERRORS, result.code, 'Не получилось'), 'error')
        return
      }
      track(AnalyticsEvent.MemoryCardAction, { action: 'accept_item' })
      memoryCard.update(result.data)
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <NoCapture>
      <Card
        className="w-full max-w-3xl gap-3 rounded-lg border-sage-line px-4 py-4 text-left shadow-none tab:px-5"
        data-testid="memory-card"
        role="region"
        aria-labelledby="memory-card-title"
      >
        <div className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-5 text-sage" strokeWidth={1.8} />
          <h2 id="memory-card-title" className="flex-1 text-base leading-tight font-semibold">
            Я запомнил
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(BUTTON, '-my-1 size-9 text-faint hover:text-foreground')}
            aria-label="Закрыть"
            onClick={() => memoryCard.close()}
            data-testid="memory-card-close"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <ul className="flex flex-col">
          {card.items.map((item) =>
            pending.has(item.fact.id) ? (
              <li
                key={item.fact.id}
                className="flex items-center justify-between gap-3 border-t border-line py-2"
                data-testid="memory-undo"
              >
                <span className="text-[0.9375rem] text-dim">Убрал.</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={ACTION}
                  onClick={() => pendingForgets.undo(item.fact.id)}
                  data-testid="memory-undo-button"
                >
                  Вернуть
                </Button>
              </li>
            ) : (
              <li
                key={item.fact.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line py-2"
                data-testid="memory-card-item"
              >
                <span className="min-w-[12rem] flex-1 text-[0.9375rem] leading-[1.45] wrap-anywhere text-foreground">
                  {item.fact.text}
                </span>
                <span className="flex gap-1.5">
                  {item.proposed && (
                    <Button
                      type="button"
                      size="sm"
                      className={cn(ACTION, 'bg-clip-border')}
                      aria-busy={busyId === item.fact.id || undefined}
                      onClick={() => void accept(item)}
                      data-testid="memory-card-accept"
                    >
                      Запомнить
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(ACTION, 'border-input!')}
                    onClick={() => dismiss(item)}
                    data-testid="memory-card-dismiss"
                  >
                    убрать
                  </Button>
                </span>
              </li>
            ),
          )}
        </ul>
        {card.more > 0 && (
          <p className="text-[0.8125rem] text-faint">И ещё {card.more} — на странице «Память».</p>
        )}
        <Link
          href="/profile/memory"
          className={cn(
            FOCUS_RING,
            'inline-flex min-h-9 w-fit items-center rounded-sm text-sm text-dim underline underline-offset-4 outline-none hover:text-foreground',
          )}
          data-testid="memory-card-link"
          // The whole list is where the person is going: the card has done its job.
          onClick={() => memoryCard.close()}
        >
          Всё, что я помню
        </Link>
      </Card>
    </NoCapture>
  )
}
