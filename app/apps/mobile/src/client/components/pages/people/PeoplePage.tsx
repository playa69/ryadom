import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Block, BlockTitle, Navbar, Page } from 'framework7-react'
import { HOTLINES, telHref } from '../../../lib/hotlines'

/**
 * The "people nearby" screen: help lines come first. Support groups and specialists
 * appear once there is a catalogue; we must not promise them before that.
 */
export default function PeoplePage() {
  return (
    <Page name="people" className="ph-no-capture">
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

      <BlockTitle>Скоро</BlockTitle>
      <Block>
        <p className="rd-muted">
          Группы поддержки и проверенные специалисты. Разговор со мной&nbsp;— это разгрузка здесь и сейчас, а не
          замена живым людям.
        </p>
      </Block>
    </Page>
  )
}
