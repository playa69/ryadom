import path from 'node:path'
import type { NextConfig } from 'next'

const repoRoot = path.resolve(import.meta.dirname, '../..')

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
  // Read by `lib/base-path.ts` in server and client code alike.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  transpilePackages: ['@ryadom/client-core', '@ryadom/contracts', '@ryadom/design', '@ryadom/ui'],
  poweredByHeader: false,
  devIndicators: false,
  reactStrictMode: true,
}

export default nextConfig
