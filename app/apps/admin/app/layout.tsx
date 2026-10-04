import type { Metadata, Viewport } from 'next'
import '@fontsource-variable/inter/wght.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'Рядом — админка',
  // The admin lives on its own host behind an Ingress allow-list; noindex is the second lock.
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
}

export const viewport: Viewport = {
  themeColor: '#ffffff',
  colorScheme: 'light',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
