'use client'

import type { ComponentProps } from 'react'
import Link from 'next/link'
import { track, trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent, MetrikaGoal, type CtaId, type StoreLink } from '@ryadom/analytics/events'
import { metrikaGoal } from '@ryadom/analytics/metrika'
import { HOTLINE_NO_CAPTURE } from '@/lib/hotlines'

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
  // Every button that opens the web app is one goal of Metrika, whatever its label and place: the cabinet's own
  // "button click" goal recognises a single button by its position and text.
  if (('store' in tracking && tracking.store === 'web_app') || ('cta' in tracking && tracking.cta === 'open_web_app')) {
    metrikaGoal(MetrikaGoal.OpenApp)
  }
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

/**
 * A tap on a hotline is counted without a browser (`trackAnonymous`). Click autocapture would count it
 * again under the browser's own id, so the SDK is told to leave that link alone (`ph-no-capture`), and so is
 * Yandex Metrika's click map and session recording (the `ym-*` classes of `HOTLINE_NO_CAPTURE`).
 */
function withNoCaptureForHotline(className: string | undefined, tracking: Tracking): string | undefined {
  if ('store' in tracking || tracking.cta !== 'hotline') return className
  return className ? `${className} ${HOTLINE_NO_CAPTURE}` : HOTLINE_NO_CAPTURE
}

/** A plain `<a>`: for addresses outside the site, `mailto:`, `tel:` and in-page anchors. */
export function TrackedLink({ tracking, onClick, className, ...props }: ComponentProps<'a'> & { tracking: Tracking }) {
  return <a {...props} className={withNoCaptureForHotline(className, tracking)} onClick={onClickWith(onClick, tracking)} />
}

/** A `next/link`: for routes of the site, which keep their client-side navigation. */
export function TrackedRouteLink({
  tracking,
  onClick,
  className,
  ...props
}: ComponentProps<typeof Link> & { tracking: Tracking }) {
  return <Link {...props} className={withNoCaptureForHotline(className, tracking)} onClick={onClickWith(onClick, tracking)} />
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
