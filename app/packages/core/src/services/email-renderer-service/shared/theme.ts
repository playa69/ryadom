import type { CSSProperties } from 'react'

/**
 * Email palette: the action blue as the accent, deep teal for links, navy ink and a cool light paper —
 * the product's night-sky hues, turned over for a daytime inbox. The
 * application interface is dark (tokens in `@ryadom/design`) while the emails are
 * light: half the mail clients render dark emails their own way, and readability matters more
 * than a uniform look.
 *
 * These are NOT the same hex values as `@ryadom/design`'s --ryadom-brand (#007aff) and
 * --ryadom-danger — that palette is tuned for near-black surfaces. The light blue text tint of the
 * dark UI (#4da3ff) on this file's white card computes to ~2.5:1 contrast, well under any WCAG text
 * threshold. `brand` and `brandDark` below are the same hue, independently darkened for a light
 * background; do not "fix" this divergence by importing the dark-mode value.
 */
export const colors = {
  brand: '#0a6cde',
  brandDark: '#0a5cc0',
  sage: '#26707a',
  ink: '#0e1631',
  paper: '#eef1fa',
  muted: '#59627f',
  line: '#dde2f1',
  white: '#ffffff',
} as const

/** Non-breaking space before a dash (copy guide). */
export const NBSP = '\u00a0'

const fontFamily =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

export const styles = {
  body: { backgroundColor: colors.paper, fontFamily, margin: 0, padding: '32px 12px' },
  container: { maxWidth: '520px', margin: '0 auto' },
  header: { padding: '0 8px 20px' },
  logo: { color: colors.ink, fontSize: '26px', fontWeight: 800, letterSpacing: '-0.5px', margin: 0 },
  card: {
    backgroundColor: colors.white,
    border: `1px solid ${colors.line}`,
    borderRadius: '28px',
    padding: '36px 30px',
  },
  heading: { color: colors.ink, fontSize: '24px', fontWeight: 800, lineHeight: '1.25', margin: '0 0 16px' },
  paragraph: { color: colors.ink, fontSize: '16px', lineHeight: '1.6', margin: '0 0 16px' },
  muted: { color: colors.muted, fontSize: '14px', lineHeight: '1.6', margin: '0 0 12px' },
  buttonWrap: { margin: '24px 0' },
  button: {
    // The darker shade keeps white text above 6:1.
    backgroundColor: colors.brandDark,
    borderRadius: '999px',
    color: colors.white,
    display: 'inline-block',
    fontSize: '16px',
    fontWeight: 700,
    padding: '14px 28px',
    textDecoration: 'none',
  },
  link: { color: colors.sage, textDecoration: 'underline', wordBreak: 'break-all' },
  code: {
    display: 'inline-block',
    color: colors.ink,
    backgroundColor: colors.paper,
    borderRadius: '16px',
    fontSize: '32px',
    fontWeight: 800,
    letterSpacing: '8px',
    padding: '16px 24px',
    margin: 0,
    border: `1px solid ${colors.line}`,
  },
  divider: { borderColor: colors.line, margin: '24px 0' },
  footer: { color: colors.muted, fontSize: '12px', lineHeight: '1.6', margin: '20px 8px 0' },
} satisfies Record<string, CSSProperties>
