import { plainTextSelectors, render } from '@react-email/render'
import type { ReactElement } from 'react'
import type { RenderedEmail } from './rendered-email'

// Plain-text version: headings stay as written (html-to-text uppercases them by default).
const htmlToTextOptions = {
  selectors: [
    ...plainTextSelectors,
    ...['h1', 'h2', 'h3'].map((selector) => ({ selector, options: { uppercase: false } })),
  ],
}

/** HTML and plain-text versions from a single React element. */
export async function renderEmail(subject: string, element: ReactElement): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true, htmlToTextOptions }),
  ])
  return { subject, html, text }
}
