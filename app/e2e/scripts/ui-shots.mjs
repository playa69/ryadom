#!/usr/bin/env node
/**
 * Screenshots of the named screens of any app (web, landing, mobile, admin), headless, against a
 * running dev or prod server. Before each picture the page is checked for visual glitches (a page
 * wider than the window, text cut off, controls on top of each other, text over text, buttons
 * stretched across a wide window, text on the very edge, a blank screen); they are printed under the
 * shot's name. Files are named <app>-<screen>-<width>.png and go to the repository's screenshots/
 * folder by default, so one run refreshes the current set of that app.
 *
 * Usage:
 *   node e2e/scripts/demo-account.mjs                      # once: the demo account with a journal (web)
 *   node e2e/scripts/ui-shots.mjs --app web --login        # saves the session of the demo account
 *   node e2e/scripts/ui-shots.mjs --app mobile --login     # the same for the Framework7 client
 *   node e2e/scripts/ui-shots.mjs --app admin --login      # admin: signs in with a code from Mailpit
 *   node e2e/scripts/ui-shots.mjs --app web                # every screen of the web app, 4 widths
 *   node e2e/scripts/ui-shots.mjs --app web --screens home,profile --widths 390,1280 --out <dir>
 *   node e2e/scripts/ui-shots.mjs --app landing --strict   # does not save a picture with glitches
 *
 * Options: --base <url> (web 3023, landing 3020, mobile 5184, admin 3021), --screens a,b,
 * --widths 390,820,1280,1920 (admin 1280,1920), --out <dir>, --state <file> (saved session),
 * --agent <url> (agent mock, 8080), --mail <url> (Mailpit, 8026), --ignore kind,kind (glitch kinds
 * to leave out), --strict. Shots that start a conversation restore the demo journal first. Exit
 * code 1 when any screen had a glitch or failed. Pair with ui-diff.mjs to compare two takes.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runShots } from './shots/runner.mjs'
import { webSpec } from './shots/web.mjs'
import { landingSpec } from './shots/landing.mjs'
import { mobileSpec } from './shots/mobile.mjs'
import { adminSpec } from './shots/admin.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (!arg.startsWith('--')) return acc
    const next = all[i + 1]
    acc.push([arg.slice(2), next && !next.startsWith('--') ? next : true])
    return acc
  }, []),
)

const SPECS = { web: webSpec, landing: landingSpec, mobile: mobileSpec, admin: adminSpec }
if (!SPECS[args.app]) {
  console.error('usage: --app web|landing|mobile|admin [--login] [--screens a,b] [--widths 390,820] [--out dir] [--strict]')
  process.exit(2)
}

process.exit(await runShots(SPECS[args.app](args, repoRoot), args, repoRoot))
