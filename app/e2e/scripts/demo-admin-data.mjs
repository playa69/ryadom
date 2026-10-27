#!/usr/bin/env node
/**
 * Fills the DEV database with a believable set of accounts and admin actions, so the admin looks like
 * an admin that has been used (screenshots, demos): a dozen people with plausible names and sign-up
 * dates over the last weeks — most active and confirmed, a few waiting for the code, one blocked, one
 * deleted — and a short audit log. The demo account of the product (zhenya.demo@example.com, see
 * demo-account.mjs) is kept and is the newest one. Everything else in `users` and `audit_log` goes.
 *
 * Only for the development database of this worktree's stand (app/.stand.json; postgres :55433 without a slot).
 * It refuses to touch anything else.
 *
 * Usage: node e2e/scripts/demo-admin-data.mjs [--db <url of that database>]
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveStand } from '../../scripts/stand-ports.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const requireFromDb = createRequire(join(repoRoot, 'packages', 'db', 'package.json'))
const postgres = requireFromDb('postgres')

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : fallback
}
const DEV_DATABASE = resolveStand().databases.dev
const URL = arg('db', DEV_DATABASE)
const sameServer = (a, b) => {
  const [x, y] = [new globalThis.URL(a), new globalThis.URL(b)]
  return ['localhost', '127.0.0.1'].includes(x.hostname) && x.port === y.port && x.pathname === y.pathname
}
if (!sameServer(URL, DEV_DATABASE)) {
  console.error(`refusing to run: this seeds only the development database of this stand (${DEV_DATABASE})`)
  process.exit(2)
}

const KEEP = 'zhenya.demo@example.com'
const ADMIN = 'admin@ryadom.local'

const ago = (days, hour, minute) => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, minute, 0, 0)
  return d
}

const PEOPLE = [
  { name: 'Анна', email: 'anna.sokolova@example.com', days: 36, h: 10, m: 12, confirmed: true },
  { name: 'Максим', email: 'maxim.orlov@example.com', days: 33, h: 21, m: 40, confirmed: true },
  { name: 'Ольга', email: 'olga.m@example.com', days: 29, h: 8, m: 55, confirmed: true },
  { name: 'Дмитрий', email: 'dmitry.v@example.com', days: 24, h: 23, m: 5, confirmed: true },
  { name: 'Екатерина', email: 'katya.petrova@example.com', days: 19, h: 13, m: 30, confirmed: true },
  { name: 'Сергей', email: 'sergey.kuznetsov@example.com', days: 15, h: 18, m: 20, confirmed: true, blocked: true },
  { name: 'Ирина', email: 'irina.belova@example.com', days: 11, h: 9, m: 45, confirmed: true },
  { name: 'Павел', email: 'pavel.s@example.com', days: 8, h: 22, m: 10, confirmed: false },
  { name: 'Наталья', email: 'natalia.fedorova@example.com', days: 5, h: 14, m: 25, confirmed: true },
  { name: 'Артём', email: 'artem.l@example.com', days: 3, h: 19, m: 50, confirmed: false },
  { name: 'Мария', email: 'maria.gromova@example.com', days: 2, h: 11, m: 5, confirmed: true },
  { name: null, email: `deleted+${randomUUID()}@anonymized.local`, days: 27, h: 16, m: 35, confirmed: true, deleted: true },
]

const sql = postgres(URL, { max: 1 })
try {
  const [{ id: keepId } = {}] = await sql`select id from users where email = ${KEEP}`
  await sql`delete from audit_log`
  await sql`delete from email_codes`
  await sql`delete from users where email <> ${KEEP}`
  if (keepId) await sql`update users set name = 'Женя', is_active = true, is_email_confirmed = true, created_at = ${ago(1, 9, 14)}, updated_at = ${ago(1, 9, 14)} where id = ${keepId}`

  const ids = {}
  for (const p of PEOPLE) {
    const created = ago(p.days, p.h, p.m)
    const [row] = await sql`
      insert into users (email, name, is_active, is_email_confirmed, is_deleted, deleted_at, created_at, updated_at)
      values (${p.email}, ${p.name}, ${!p.blocked && !p.deleted}, ${p.confirmed}, ${Boolean(p.deleted)}, ${p.deleted ? ago(p.days - 4, 12, 0) : null}, ${created}, ${created})
      returning id`
    ids[p.email] = row.id
  }

  const log = [
    ['USER_EMAIL_CONFIRMED', 'natalia.fedorova@example.com', 4, 12, 5, {}],
    ['USER_BLOCKED', 'sergey.kuznetsov@example.com', 9, 17, 30, { reason: 'спам в разговорах' }],
    ['USER_ACCOUNT_DELETED', null, 23, 12, 0, {}],
    ['USER_UNBLOCKED', 'olga.m@example.com', 14, 10, 20, {}],
    ['USER_BLOCKED', 'olga.m@example.com', 14, 9, 55, {}],
  ]
  for (const [action, email, days, h, m, payload] of log) {
    const target = email ?? PEOPLE.find((p) => p.deleted).email
    await sql`
      insert into audit_log (admin_email, action, target_user_id, target_email, payload, created_at)
      values (${ADMIN}, ${action}, ${ids[target] ?? null}, ${target}, ${JSON.stringify(payload)}::jsonb, ${ago(days, h, m)})`
  }

  const [{ count }] = await sql`select count(*)::int as count from users`
  console.log(`${count} accounts, ${log.length} admin actions in the dev database`)
} finally {
  await sql.end()
}
