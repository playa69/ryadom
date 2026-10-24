import type { Router } from 'framework7/types'
import { Icon } from 'framework7-react'
import DiaryShell from './DiaryShell'

/**
 * Segment «Итоги»: the summaries of conversations. They come from the agent's memory notes
 * (PROTEUS-242), which are not ready: until then the segment says what will be here.
 */
export default function RecapsPage({ f7router }: { f7router: Router.Router }) {
  return (
    <DiaryShell segment="recaps" f7router={f7router}>
      <div className="rd-empty" data-testid="diary-recaps-empty">
        <span className="rd-empty-icon" aria-hidden="true">
          <Icon f7="doc_text" size={28} />
        </span>
        <p className="rd-muted">
          Здесь будут итоги ваших разговоров: о чём говорили, что стало главным и о чём договорились. Итог
          появляется сам, когда разговор закончился
        </p>
      </div>
    </DiaryShell>
  )
}
