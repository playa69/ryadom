import type { Metadata, Viewport } from 'next'
// Same package the app uses, so the two never fetch different builds of the same typeface and
// this site never reaches Google Fonts for it.
import '@fontsource-variable/inter/wght.css'
import './globals.css'

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className="dark">
      <body className={SKY}>{children}</body>
    </html>
  )
}
