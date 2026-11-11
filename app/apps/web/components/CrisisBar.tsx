'use client'

import { Phone } from 'lucide-react'
import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { SafetyAnswer } from '@ryadom/contracts/api/dialogs'
import type { CrisisUi } from '@ryadom/client-core/safety-state'
import { CRISIS_CALL, telHref } from '@ryadom/client-core/hotlines'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON, COLUMN } from './controls'

/**
 * The crisis script (PROTEUS-279) on the conversation screen: the call button pinned above the conversation
 * until the session ends, the quick answers under a question of the agent, and the "Need help?" banner after
 * a "no" to the yellow question. Everything here is counted with no person attached.
 */
export default function CrisisBar({
  ui,
  onCall,
  onAnswer,
  onOpenSos,
}: {
  ui: CrisisUi
  onCall(): void
  onAnswer(answer: SafetyAnswer): void
  onOpenSos(): void
}) {
  if (!ui.pinned && !ui.banner && !ui.ask) return null
  return (
    <div className={cn(COLUMN, 'ph-no-capture flex flex-col gap-2 pt-3')} data-testid="crisis-bar">
      {ui.pinned && (
        <Button asChild size="lg" variant="destructive" className={cn(BUTTON, 'w-full gap-2 font-bold')}>
          <a
            href={telHref(CRISIS_CALL.phone)}
            data-testid="crisis-call"
            onClick={() => {
              trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: CRISIS_CALL.name })
              onCall()
            }}
          >
            <Phone className="size-4" aria-hidden="true" />
            Позвонить сейчас
          </a>
        </Button>
      )}
      {ui.banner && !ui.pinned && (
        <Button type="button" variant="outline" className={cn(BUTTON, 'w-full border-input!')} onClick={onOpenSos} data-testid="crisis-banner">
          Нужна помощь?
        </Button>
      )}
      {ui.ask && (
        <div className="flex gap-2" role="group" aria-label="Быстрый ответ" data-testid="crisis-ask">
          <Button type="button" variant="secondary" className={cn(BUTTON, 'flex-1')} onClick={() => onAnswer('yes')}>
            Да
          </Button>
          <Button type="button" variant="secondary" className={cn(BUTTON, 'flex-1')} onClick={() => onAnswer('no')}>
            Нет
          </Button>
          {ui.ask === 'safe' && (
            <Button type="button" variant="secondary" className={cn(BUTTON, 'flex-1')} onClick={() => onAnswer('unknown')}>
              Не знаю
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
