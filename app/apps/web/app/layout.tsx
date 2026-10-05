import type { Metadata, Viewport } from 'next'
import { connection } from 'next/server'
import '@fontsource-variable/inter/wght.css'
import './globals.css'
import { readApiBase } from '@/lib/api-url'
import Providers from './providers'

export const metadata: Metadata = {
  title: { default: 'Рядом', template: '%s — Рядом' },
  // The product lives behind a sign-in; only the landing (apps/landing) is meant to be indexed.
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
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
  return (
    // scroll-pt: the sticky AppHeader (h-14 plus the notch inset) must not cover the control that keyboard focus scrolls into view.
    <html lang="ru" className="dark scroll-pt-[calc(4rem+env(safe-area-inset-top,0px))]">
      <body>
        <Providers apiBase={readApiBase()}>{children}</Providers>
      </body>
    </html>
  )
}
