import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Icon } from 'framework7-react'
import type { SafetyAnswer } from '@ryadom/contracts/api/dialogs'
import type { CrisisUi } from '@ryadom/client-core/safety-state'
import { CRISIS_CALL, telHref } from '../lib/hotlines'

/**
 * The crisis script (PROTEUS-279) on the conversation screen: the call button pinned above the conversation until
 * the session ends, quick answers under a question of the agent, and the "Need help?" banner. Counted with no person.
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
    <div className="rd-crisis-bar ph-no-capture" data-testid="crisis-bar">
      {ui.pinned && (
        <a
          className="rd-crisis-call"
          data-testid="crisis-call"
          href={telHref(CRISIS_CALL.phone)}
          onClick={() => {
            trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: CRISIS_CALL.name })
            onCall()
          }}
        >
          <Icon f7="phone_fill" size={16} />
          Позвонить сейчас
        </a>
      )}
      {ui.banner && !ui.pinned && (
        <button type="button" className="rd-crisis-banner" data-testid="crisis-banner" onClick={onOpenSos}>
          Нужна помощь?
        </button>
      )}
      {ui.ask && (
        <div className="rd-crisis-ask" role="group" aria-label="Быстрый ответ" data-testid="crisis-ask">
          <button type="button" onClick={() => onAnswer('yes')}>
            Да
          </button>
          <button type="button" onClick={() => onAnswer('no')}>
            Нет
          </button>
          {ui.ask === 'safe' && (
            <button type="button" onClick={() => onAnswer('unknown')}>
              Не знаю
            </button>
          )}
        </div>
      )}
    </div>
  )
}
