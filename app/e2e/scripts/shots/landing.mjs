import { standUrls } from './stand.mjs'

/** apps/landing: public pages, shot as the whole page. */
export function landingSpec(args) {
  const base = String(args.base ?? standUrls(args).landing).replace(/\/$/, '')
  const pages = { home: '/', privacy: '/privacy', terms: '/terms', download: '/download', 'delete-account': '/delete-account' }
  const screens = Object.fromEntries(
    Object.entries(pages).map(([name, path]) => [
      name,
      { anon: true, fullPage: true, open: async (page) => { await page.goto(`${base}${path}`, { waitUntil: 'networkidle' }) } },
    ]),
  )
  return { app: 'landing', base, screens, ctx: {}, heights: (width) => ({ 390: 844, 820: 1180, 1280: 800, 1920: 1080 }[width] ?? 900) }
}
