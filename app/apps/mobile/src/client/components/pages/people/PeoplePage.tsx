import { SPECIALISTS, SPECIALISTS_NOTE } from '@ryadom/client-core/specialists'
import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Block, BlockTitle, Navbar, Page } from 'framework7-react'
import { useRef } from 'react'
import { HOTLINES, telHref } from '../../../lib/hotlines'

export const PEOPLE_PATH = '/people/'

export function revealSpecialists(section: Element | null) {
  const heading = section?.querySelector<HTMLElement>('[data-specialists]')
  heading?.scrollIntoView({ block: 'start' })
  heading?.focus({ preventScroll: true })
}

export default function PeoplePage({ showSpecialists = false }: { showSpecialists?: boolean }) {
  const specialistsSection = useRef<HTMLElement>(null)
  return (
    <Page
      name="people"
      className="ph-no-capture"
      onPageAfterIn={() => {
        if (showSpecialists && specialistsSection.current) revealSpecialists(specialistsSection.current)
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

      <section ref={specialistsSection} aria-labelledby="specialists">
        <h2 className="block-title" id="specialists" data-specialists tabIndex={-1}>
          Специалисты
        </h2>
        <Block>
          <p className="rd-muted">{SPECIALISTS_NOTE}</p>
        </Block>
        <ul className="rd-specialists">
          {SPECIALISTS.map(({ name, description, phone }) => (
            <li key={phone} className="rd-card">
              <h3>{name}</h3>
              <p className="rd-muted">{description}</p>
              <a className="rd-inline-link" href={telHref(phone)}>
                {phone}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  )
}
