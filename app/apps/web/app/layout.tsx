import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { connection } from 'next/server'
import '@fontsource-variable/inter/wght.css'
import './globals.css'
import { readApiBase } from '@/lib/api-url'
import { appPath } from '@/lib/base-path'
import Providers from './providers'
import { THEME_BOOT } from './theme-boot'

export const metadata: Metadata = {
  title: { default: 'Рядом', template: '%s — Рядом' },
  // The product lives behind a sign-in; only the landing (apps/landing) is meant to be indexed.
  robots: { index: false, follow: false },
  // Next does not prefix a string icon URL with the base path.
  icons: { icon: appPath('/favicon.svg') },
}

// Zoom stays enabled: pinch-zoom is an accessibility feature, not ours to take away.
export const viewport: Viewport = {
  themeColor: '#00051a',
  colorScheme: 'dark',
  viewportFit: 'cover',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request render: the CSP nonce and the API address are both runtime values.
  await connection()
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    // scroll-pt: the sticky AppHeader (h-14 plus the notch inset) must not cover the control that keyboard focus scrolls into view.
    // suppressHydrationWarning: the boot script may flip the theme attributes before React hydrates.
    <html
      lang="ru"
      suppressHydrationWarning
      className="dark scroll-pt-[calc(4rem+env(safe-area-inset-top,0px))]"
    >
      <body>
        {/*
          The theme must be set before the first paint, or the page flashes the wrong palette. The
          strict CSP runs no script without the per-request nonce, so it is handed in explicitly.
        */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <Providers apiBase={readApiBase()}>{children}</Providers>
      </body>
    </html>
  )
}
