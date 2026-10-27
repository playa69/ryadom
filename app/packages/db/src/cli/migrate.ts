// Entry point for `pnpm db:migrate` and for the migrate image (bundled as dist/migrate.mjs).
// Any error exits non-zero, so compose does not start applications on top of a failed migration.
import { runMigrations } from '../migrate'

const LOCAL_DATABASE_URL = 'postgres://ryadom:ryadom@localhost:55433/ryadom'

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (url) return url
  // In a container the variable is required: silently falling back to localhost is not acceptable.
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is not set')
  return LOCAL_DATABASE_URL
}

function redact(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return '<invalid url>'
  }
}

async function main(): Promise<void> {
  const url = databaseUrl()
  const log = (message: string) => console.log(`[migrate] ${message}`)
  log(`database: ${redact(url)}`)
  const started = Date.now()
  const result = await runMigrations({ url, log })
  const took = Date.now() - started
  if (result.applied.length === 0) {
    log(`schema is up to date (${result.total} migrations), ${took} ms`)
  } else {
    log(`applied ${result.applied.length} of ${result.total}: ${result.applied.join(', ')} (${took} ms)`)
  }
  log(
    result.jobsSchema.changed
      ? `job queue schema installed or upgraded, version ${result.jobsSchema.version}`
      : `job queue schema is up to date, version ${result.jobsSchema.version}`,
  )
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[migrate] failed:', error)
    process.exit(1)
  },
)
