'use client'

import type { ComponentProps } from 'react'
import Link from 'next/link'
import { track, trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type CtaId, type StoreLink } from '@ryadom/analytics/events'

/*
 * The site is rendered on the server, so a click cannot be counted from there. These are the thin
 * client parts: the same element as without them, plus a report of what the visitor did. They never
 * prevent the default action or delay it; a click that leaves the page relies on the analytics
 * package, which queues events and flushes them when the page is hidden.
 */

/**
 * What a click is reported as: a call to action and where on the site it sits (a short, stable slug
 * such as `hero` or `footer`), or a link to a place to get the app.
 */
type Tracking = { cta: CtaId; placement: string } | { store: StoreLink }

function reportClick(tracking: Tracking): void {
  if ('store' in tracking) {
    track(AnalyticsEvent.StoreLinkClicked, { store: tracking.store })
    return
  }
  const properties = { cta: tracking.cta, placement: tracking.placement }
  // A tap on a crisis hotline is counted, but never attached to a browser: how often, not whose.
  if (tracking.cta === 'hotline') trackAnonymous(AnalyticsEvent.CtaClicked, properties)
  else track(AnalyticsEvent.CtaClicked, properties)
}

function onClickWith<E>(onClick: ((event: E) => void) | undefined, tracking: Tracking): (event: E) => void {
  return (event) => {
    onClick?.(event)
    reportClick(tracking)
  }
}

/** A plain `<a>`: for addresses outside the site, `mailto:`, `tel:` and in-page anchors. */
export function TrackedLink({ tracking, onClick, ...props }: ComponentProps<'a'> & { tracking: Tracking }) {
  return <a {...props} onClick={onClickWith(onClick, tracking)} />
}

/** A `next/link`: for routes of the site, which keep their client-side navigation. */
export function TrackedRouteLink({ tracking, onClick, ...props }: ComponentProps<typeof Link> & { tracking: Tracking }) {
  return <Link {...props} onClick={onClickWith(onClick, tracking)} />
}

/**
 * A `<details>` that reports being opened (not closed). `faq` is a stable name of the question, never
 * its text, so rewording an answer keeps the history of its opens.
 */
export function TrackedDetails({ faq, onToggle, ...props }: ComponentProps<'details'> & { faq: string }) {
  return (
    <details
      {...props}
      onToggle={(event) => {
        onToggle?.(event)
        if (event.currentTarget.open) track(AnalyticsEvent.FaqOpened, { question: faq })
      }}
    />
  )
}
