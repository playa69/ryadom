'use client'

import { useId } from 'react'
import { HOTLINES } from '@ryadom/client-core/hotlines'
import { Card } from '@ryadom/ui/components/card'
import Hotline from './Hotline'
import { Page, SECTION_HEADING } from './Page'

/**
 * The "people nearby" page: help lines come first. Support groups and specialists
 * appear once there is a catalogue; we must not promise them before that. The list is bundled, so
 * there is nothing to load or refresh and it works offline.
 */
export default function PeopleScreen() {
  const callId = useId()
  const soonId = useId()

  return (
    <Page title="Люди рядом" className="gap-10">
      <section className="flex flex-col gap-3.5" aria-labelledby={callId}>
        <h2 id={callId} className={SECTION_HEADING}>
          Позвонить прямо сейчас
        </h2>
        <div className="grid gap-3" data-testid="hotlines">
          {HOTLINES.map((hotline) => (
            <Hotline key={hotline.phone} hotline={hotline} showCallIcon data-testid="hotline" />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3.5" aria-labelledby={soonId}>
        <h2 id={soonId} className={SECTION_HEADING}>
          Скоро
        </h2>
        <Card className="rounded-lg px-5 py-4 shadow-none">
          <p className="text-base leading-[1.55] text-dim">
            Группы поддержки и проверенные специалисты. Разговор со мной&nbsp;— это разгрузка здесь и сейчас,
            а не замена живым людям.
          </p>
        </Card>
      </section>
    </Page>
  )
}
