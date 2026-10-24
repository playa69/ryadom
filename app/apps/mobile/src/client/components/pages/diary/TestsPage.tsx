import type { Router } from 'framework7/types'
import { Icon } from 'framework7-react'
import DiaryShell from './DiaryShell'

/** Segment «Тесты»: the tests inside the app are PROTEUS-218; the segment is here so the section is whole. */
export default function TestsPage({ f7router }: { f7router: Router.Router }) {
  return (
    <DiaryShell segment="tests" f7router={f7router}>
      <div className="rd-empty" data-testid="diary-tests-soon">
        <span className="rd-empty-icon" aria-hidden="true">
          <Icon f7="checkmark_seal" size={28} />
        </span>
        <p className="rd-muted">Скоро здесь появятся короткие тесты, чтобы лучше понять, как ты</p>
      </div>
    </DiaryShell>
  )
}
