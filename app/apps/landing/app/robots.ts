import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    // The web app lives under /app, but this host serves the one robots.txt of the site. Links to conversations are
    // closed here on top of the page's own noindex header; the rest of the site stays open.
    rules: { userAgent: '*', allow: '/', disallow: '/app/s/' },
  }
}
