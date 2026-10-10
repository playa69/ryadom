import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NextConfig } from 'next'

const repoRoot = path.resolve(import.meta.dirname, '../..')

/** The version of this package, reported with analytics events as `app_version`. */
const { version } = JSON.parse(readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8')) as {
  version: string
}

/**
 * The URL prefix the web client is published under on a shared host (`/app`), empty when it has a
 * host of its own. It is fixed at build time (`BASE_PATH`): Next bakes it into the server, the
 * asset URLs and the router, so one image serves one prefix. See `lib/base-path.ts` for the places
 * Next does not prefix by itself.
 */
function readBasePath(value: string | undefined): string {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) {
    throw new Error(`BASE_PATH must look like "/app" (got "${value}")`)
  }
  return trimmed
}

const basePath = readBasePath(process.env.BASE_PATH)

const nextConfig: NextConfig = {
  output: 'standalone',
  basePath,
  // Read by `lib/base-path.ts` (the prefix) and `lib/analytics-provider.tsx` (the version) in client code.
  env: { NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_APP_VERSION: version },
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  transpilePackages: [
    '@ryadom/analytics',
    '@ryadom/client-core',
    '@ryadom/contracts',
    '@ryadom/design',
    '@ryadom/ui',
  ],
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
}

export default nextConfig
