---
name: e2e
description: End-to-end tests of Ryadom and manual browser checks — the Playwright suite app/e2e (its own environment built from production builds, projects desktop and mobile), how many tests to run during a task and before submitting, parallel runs on shifted ports, builds from the Turborepo cache, checks through Playwright MCP with a microphone. Use for requests like "run e2e", "check it in the browser", "click through it", "check that nothing broke".
---

# End-to-end tests and browser checks

The **local environment** is checked, not production: production is read-only (the `logs` skill). The suite is
`app/e2e` (Playwright, over a hundred tests, projects `desktop` and `mobile` (Pixel 7 with a fake microphone), one
worker; the whole suite takes about 10 minutes plus the build).

## How many to run

- **During a task** (every edit, every reply to a comment) — only the specs of the affected feature, on both projects:
  `pnpm --filter @ryadom/e2e exec playwright test web-memory app-memory` (file names in `e2e/tests/`). Plus typecheck
  and unit tests of the affected packages (the `local-dev` skill).
- **Before submitting** (the user asks "is it done?", the PR goes to review or merge) — the whole suite
  `pnpm test:e2e`, once.
- A test of someone else's feature failed — rerun it alone: `web-shell` occasionally flakes; if it fails again,
  investigate.

## Running

```bash
cd app
pnpm test:e2e                                                           # whole suite
pnpm --filter @ryadom/e2e exec playwright test --project=mobile app-dialog   # part: project and files
pnpm --filter @ryadom/e2e report                                        # HTML report from e2e/report
```

`webServer` in `playwright.config.ts` runs `e2e/scripts/stack.mjs`: compose `e2e/compose.yaml` (PostgreSQL in tmpfs
:55434, Mailpit :1027/:8027, agent mock :8081, with `--build`), migrations, **production builds** of the apps and the
servers: landing :3100, api :3102, web :3103, PWA :3104 (`vite preview`); there is no admin panel in this environment.
Readiness — `http://127.0.0.1:3100/api/health`; at the end the environment is torn down together with its volumes.

- **Builds go through Turborepo with a cache:** an app whose sources (and the sources of its packages) have not changed
  since the last build comes from the cache in seconds. `TURBO_CACHE_DIR` gives several checkouts one cache.
- **Parallel runs go on shifted ports.** `E2E_PORT_OFFSET=100` shifts all the environment's ports (3200, 3202, …,
  55534, 8127, 8181) and gives the compose project its own name, so runs from different worktrees do not wait for each
  other.
- **Someone else's environment on the same ports will be reused** (`reuseExistingServer` outside CI), and the tests
  will pass against someone else's code. Before running, check that the ports are free (`ss -ltn`, on Windows
  `netstat -ano`); if they are busy, take another offset and do not stop other people's processes.
- It takes long: run it in the background with the log in a file and wait for completion rather than polling in a loop;
  in the log, `grep -v '^\[WebServer\]'` removes the environment noise.
- The Playwright browser for the suite is installed once: `pnpm --filter @ryadom/e2e exec playwright install chromium`.

New tests go next to similar ones in `e2e/tests/`, shared steps (sign-in, codes from Mailpit, Telegram) go in
`e2e/support/`, and environment addresses are constants from `playwright.config.ts` (`APP_URL`, `MAIL_URL`,
`AGENT_URL`, …), not hardcoded ports. In the test and in the PR, cite the OpenSpec requirement and the `REQ-…` from
docs/spec.md, if there is one.

## Manual check (Playwright MCP)

The environment — the `local-dev` skill (`pnpm dev`). Surfaces: landing, web, PWA and admin panel; in dev each app is on
its own port and at the root, without the production prefixes `/app`, `/pwa`, `/admin`. Sign-in — anonymous, with a
code from Mailpit, or into the admin panel (the `local-dev` skill).

- **Microphone:** on a new origin `getUserMedia` waits for an answer to the permission prompt, and the call hangs until
  the MCP timeout. Grant the permission first: `page.context().grantPermissions(['microphone'], { origin })`
  (`browser_run_code_unsafe`).
- **Sound:** on the user's machine the browser plays the agent mock's voice into that machine's real output, i.e. into
  the user's headphones: warn them or check without voice. Headless Chromium without a sound card (the agent's machine)
  plays into nothing.
- **Screenshots** — the `screenshots` skill (by script, only the needed screens), not by hand through MCP.

## What is not checked

Sound by ear and voice quality, real models (the mock answers with templates; the real agent — `local-dev`), real
devices (iOS before 26, Android WebView, Firefox), the Telegram Mini App inside the Telegram client, load. In the report
list the unchecked items explicitly; do not present a partial check as a complete one.

Related: [[local-dev]] — the development environment and sign-in; [[screenshots]] — screen captures; [[deploy]] —
checks on production.
