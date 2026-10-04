import path from 'node:path'
import type { NextConfig } from 'next'

const repoRoot = path.resolve(import.meta.dirname, '../..')

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  // Workspace packages ship TypeScript sources, so Next compiles them itself.
  transpilePackages: ['@ryadom/core', '@ryadom/db'],
  // Native modules and anything owning its own worker threads stay outside the bundle.
  serverExternalPackages: ['@node-rs/argon2', 'pino', 'pino-pretty', 'thread-stream'],
  poweredByHeader: false,
  // The dev-mode badge sits over the bottom-left corner, on top of the sidebar's last link.
  devIndicators: false,
  reactStrictMode: true,
  // `next dev` otherwise prints every action call with its arguments, and those include the
  // one-time codes from the login form.
  logging: { serverFunctions: false },
}

export default nextConfig
