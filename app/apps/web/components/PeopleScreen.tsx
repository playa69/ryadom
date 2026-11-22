'use client'

import { useId } from 'react'
import { HOTLINES, telHref } from '@ryadom/client-core/hotlines'
import { SPECIALISTS, SPECIALISTS_NOTE } from '@ryadom/client-core/specialists'
import { Card } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import { FOCUS_RING } from './controls'
import Hotline from './Hotline'
import { Page, SECTION_HEADING } from './Page'

export default function PeopleScreen() {
  const callId = useId()
  const specialistsId = 'specialists'

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

      <section className="ph-no-capture flex flex-col gap-3.5" aria-labelledby={specialistsId}>
        <h2 id={specialistsId} className={SECTION_HEADING} tabIndex={-1}>
          Специалисты
        </h2>
        <p className="text-base leading-[1.55] text-dim">{SPECIALISTS_NOTE}</p>
        <ul className="grid gap-3">
          {SPECIALISTS.map(({ name, description, phone }) => (
            <li key={phone}>
              <Card className="gap-2 rounded-lg px-5 py-4 shadow-none">
                <h3 className="font-semibold">{name}</h3>
                <p className="text-base leading-[1.55] text-dim">{description}</p>
                <a
                  className={cn(
                    'inline-flex min-h-11 w-fit items-center rounded-sm text-brand-400 underline underline-offset-4',
                    FOCUS_RING,
                  )}
                  href={telHref(phone)}
                >
                  {phone}
                </a>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  )
}
