'use client'

import { useId } from 'react'
import { HOTLINES, telHref } from '@ryadom/client-core/hotlines'
import {
  SPECIALISTS,
  SPECIALISTS_INTRO,
  SPECIALISTS_NOTE,
  SPECIALISTS_TITLE,
} from '@ryadom/client-core/specialists'
import { Card } from '@ryadom/ui/components/card'
import Hotline from './Hotline'
import { Page, SECTION_HEADING } from './Page'

export default function PeopleScreen() {
  const callId = useId()
  const specialistsId = useId()

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

      <section
        id="specialists"
        className="ph-no-capture flex scroll-mt-24 flex-col gap-3.5"
        aria-labelledby={specialistsId}
      >
        <h2 id={specialistsId} className={SECTION_HEADING}>
          {SPECIALISTS_TITLE}
        </h2>
        <p className="text-base leading-relaxed text-dim">{SPECIALISTS_INTRO}</p>
        <div className="grid gap-3">
          {SPECIALISTS.map(({ name, description, phone }) => (
            <Card key={name} className="gap-2 rounded-lg px-5 py-4 shadow-none">
              <h3 className="text-lg font-semibold">{name}</h3>
              <p className="text-base leading-relaxed text-dim">{description}</p>
              <a
                href={telHref(phone)}
                className="inline-flex min-h-11 w-fit items-center text-brand-400 underline underline-offset-4"
              >
                {phone}
              </a>
            </Card>
          ))}
        </div>
        <p className="text-sm leading-relaxed text-dim">{SPECIALISTS_NOTE}</p>
      </section>
    </Page>
  )
}
