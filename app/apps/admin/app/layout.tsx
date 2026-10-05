import type { Metadata, Viewport } from 'next'
import '@fontsource-variable/inter/wght.css'
import './globals.css'
import { appPath } from '@/lib/base-path'

export const metadata: Metadata = {
  title: 'Рядом — админка',
  // The admin is not for search engines; noindex is the second lock after the sign-in.
  robots: { index: false, follow: false },
  // Next does not prefix a string icon URL with the base path.
  icons: { icon: appPath('/favicon.svg') },
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
