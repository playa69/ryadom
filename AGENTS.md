# Ryadom: rules for agents

Every agent on the team reads this file: Codex and Kimi Code directly, Claude Code through `CLAUDE.md`. It holds what
every task needs; step-by-step procedures are in skills (below). The product and how to run it — README.md.

## Where things are

- `app/` — pnpm + Turborepo, Node 24: `services/api` (Hono: REST `/api/*` and the WebSocket gateway to the agent),
  `apps/web`, `apps/landing`, `apps/admin` (Next.js), `apps/mobile` (PWA, Android and iOS on Framework7 + Capacitor),
  `packages/*`, `e2e` (Playwright), `dev/agent-mock` (agent mock).
- `agent/` — the conversation agent: Python 3.12, FastAPI, uv; PostgreSQL, Cognee, Langfuse.
- `k8s/` — manifests of the only cluster (Timeweb `twc-sber500`, a single environment — prod) and runbooks.
- `openspec/` — behavior specs; `docs/` — the product spec (`docs/spec.md`) and analytics.

## Source of truth

For now — the code in `main`: there is no `openspec/specs/` yet, and the old changes have drifted from the code. Where
a spec contradicts the code, the code wins; name the mismatch in the report and the PR. A behavior change starts with an
OpenSpec change — skill `openspec`.

## Rules

- Work in your own git worktree and your own branch from a fresh `origin/main`. Do not switch branches or commit in the
  shared directory: other agents work there.
- Into `main` only through a PR; a human merges and rolls out. No force-push and no history rewriting.
- The repository is public: no secrets, internal node addresses, people's email addresses, payment account names or
  backup details. About secrets say only that they are "kept locally by the administrator".
- Conversations of real people from production (work, places, close people, verbatim phrases) never go into tests,
  fixtures, commits, PRs or issues: synthetic data only.
- Production — reading as well as changing — only after a human's explicit "yes" for the specific operation.
- No tool attribution lines (`Co-Authored-By`, "Generated with …") in commits and PRs.
- Language: code comments in `app/` — English and only about reasons; in `agent/`, documentation and UI texts —
  Russian. Agent instructions (`AGENTS.md`) and skills — English.

## Checks

- While working — typecheck and tests of the affected packages, e2e of the affected feature; before handing over — the
  full set (skills `local-dev`, `e2e`).
- A visual change — screenshots of the user scenario steps at 390 and 1280, no video (skill `screenshots`).
- In the report, list plainly what was not checked.

## Code rules by folder

How the code in a folder is built (configuration, logs, headers, comment language) lives in nested `AGENTS.md` files:
`agent/AGENTS.md`, `app/AGENTS.md`, `app/packages/core/AGENTS.md`. Next to each one is a `CLAUDE.md` with the single
line `@AGENTS.md`: with a root `CLAUDE.md`, Claude Code does not read nested `AGENTS.md` files by itself. A rule that
always applies in a folder goes there; a skill is a step-by-step procedure taken when needed (run, check, roll out).

## Skills

One folder for all agents — `.agents/skills/<name>/SKILL.md`. Claude Code reads only `.claude/skills/`, so copies live
there.

- Skills are written in English.
- Edit or add a skill only in `.agents/skills/`, then run `node scripts/sync-agent-skills.mjs` and commit the copies in
  the same commit. Check — `node scripts/sync-agent-skills.mjs --check`.
- OpenSpec has one skill, `openspec`. Do not run `openspec init` or `openspec update`: they lay out one skill per
  operation in `.agents/skills/`.
- What there is:
  - development: `local-dev`, `e2e`, `screenshots`, `commit`, `openspec`;
  - production: `deploy`, `logs`, `db`, `analytics`, `backup`;
  - team memory: `ryadom-cognee-mcp`.

Multica agents also get the platform's own rules (issues, statuses, the report in the issue) and the instructions of
their machine; those are not about the code and live in Multica.
