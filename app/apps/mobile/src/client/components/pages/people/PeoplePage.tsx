import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import {
  SPECIALISTS,
  SPECIALISTS_INTRO,
  SPECIALISTS_NOTE,
  SPECIALISTS_TITLE,
} from '@ryadom/client-core/specialists'
import { Block, BlockTitle, Navbar, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { HOTLINES, telHref } from '../../../lib/hotlines'

export default function PeoplePage({ f7route }: { f7route: Router.Route }) {
  return (
    <Page
      name="people"
      className="ph-no-capture"
      onPageAfterIn={({ el }: { el: HTMLElement }) => {
        if (f7route.query.section === 'specialists') {
          const heading = el.querySelector<HTMLElement>('#specialists')
          heading?.focus({ preventScroll: true })
          heading?.scrollIntoView()
        }
      }}
    >
      <Navbar backLink="Назад" title="Люди рядом" />

      <BlockTitle>Позвонить прямо сейчас</BlockTitle>
      <Block className="rd-hotlines">
        {HOTLINES.map((hotline) => (
          <a
            key={hotline.phone}
            className="rd-hotline ph-no-capture"
            href={telHref(hotline.phone)}
            onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: hotline.name })}
          >
            <span className="rd-hotline-name">{hotline.name}</span>
            <span className="rd-hotline-phone">{hotline.phone}</span>
          </a>
        ))}
      </Block>

      <Block>
        <section className="rd-people-specialists" aria-labelledby="specialists">
          <h2 id="specialists" className="rd-title" tabIndex={-1}>
            {SPECIALISTS_TITLE}
          </h2>
          <p className="rd-muted">{SPECIALISTS_INTRO}</p>
          <div className="rd-hotlines">
            {SPECIALISTS.map(({ name, description, phone }) => (
              <article key={name} className="rd-card">
                <h3>{name}</h3>
                <p className="rd-muted">{description}</p>
                <a href={telHref(phone)} className="rd-inline-link external">
                  {phone}
                </a>
              </article>
            ))}
          </div>
          <p className="rd-muted">{SPECIALISTS_NOTE}</p>
        </section>
      </Block>
    </Page>
  )
}
