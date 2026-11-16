import type { Metadata, Viewport } from 'next'
import { connection } from 'next/server'
// Same package the app uses, so the two never fetch different builds of the same typeface and
// this site never reaches Google Fonts for it.
import '@fontsource-variable/inter/wght.css'
import './globals.css'
import { getWebEnv } from '@/lib/env'
import { AnalyticsBoot } from './_components/analytics-boot'
import { ThemeRuntime } from './_components/theme-runtime'
import { THEME_BOOT } from './theme-boot'

export const metadata: Metadata = {
  title: 'Рядом — когда нужно, чтобы кто-то был рядом',
  description:
    'Голосовой собеседник для эмоциональной разгрузки: выслушает без осуждения в любой момент. Не психотерапия, а первая опора и мост к живым людям.',
  applicationName: 'Рядом',
  openGraph: {
    title: 'Рядом',
    description: 'Голосовой собеседник для эмоциональной разгрузки. Без осуждения, без очереди, без записи.',
    type: 'website',
    locale: 'ru_RU',
  },
  icons: { icon: '/favicon.svg' },
}

export const viewport: Viewport = {
  themeColor: '#00051a',
  colorScheme: 'dark',
}

/*
 * The shared sky is one fixed picture, and a whole-page capture paints it only over the first
 * screen: the stars end after 800px and its violet bloom, anchored to the viewport's bottom edge,
 * ends in a hard line. Here the stars scroll with the page, so every part of a long page has them,
 * and the bloom sits inside the viewport and fades out before its bottom edge.
 */
const SKY =
  'bg-[image:var(--ryadom-stars),radial-gradient(85%_55%_at_50%_-8%,var(--ryadom-bloom-teal),transparent_72%),radial-gradient(65%_55%_at_100%_52%,var(--ryadom-bloom-indigo),transparent_72%),radial-gradient(75%_36%_at_0%_64%,var(--ryadom-bloom-violet),transparent_72%)] [background-attachment:scroll,fixed,fixed,fixed]'

/**
 * Like the pages, rendered per request: the API address comes from the container's environment
 * rather than the moment of the build. Every page already does this, so only the 404 page, which
 * was prerendered, is rendered on demand now.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection()
  const env = getWebEnv()

  return (
    // suppressHydrationWarning: the boot script may flip the theme attributes before React hydrates.
    <html lang="ru" className="dark" suppressHydrationWarning>
      <body className={SKY}>
        {/*
          The theme must be set before the first paint, or the page flashes the wrong palette.
          The site sends no CSP of its own, so a plain inline script is enough.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <ThemeRuntime />
        <AnalyticsBoot apiBase={env.apiUrl} />
        {children}
      </body>
    </html>
  )
}
