---
name: local-dev
description: Bring up Ryadom locally and run checks — PostgreSQL, Redis, Mailpit and the agent mock in Docker, dev servers for api, web, landing, admin and PWA, the real Python agent (templates or models), signing in anonymously, with an emailed code and into the admin panel, typecheck, app tests, agent pytest, ruff. Use for requests like "run it locally", "bring up the environment", "check that it works", "run the tests", "why do the tests fail", before a commit and before e2e.
---

# Local run and checks

The `app/` monorepo (pnpm + Turborepo, Node 24) and the `agent/` agent (Python 3.12, uv). The quick start is in the
README, section «Быстрый старт»; this file covers what people tripped on there.

Docker is needed for the infrastructure. On Windows it lives in WSL: `app/scripts/docker.mjs` switches to `wsl docker`
by itself when Windows has no docker, so `pnpm infra:up` works from there too.

## Development environment

```bash
cd app
pnpm install --frozen-lockfile   # in a fresh worktree; several agents in one directory — node scripts/with-lock.mjs pnpm install
pnpm infra:up                    # PostgreSQL :55433, Redis :56379, Mailpit :1026 (SMTP) and :8026 (UI), agent mock :8080
pnpm db:migrate
pnpm dev                         # landing :3000, admin :3001, api :3002, web :3003, PWA (vite) :5174
```

Parts separately: `pnpm dev:api`, `dev:web`, `dev:admin`, `dev:landing`, `dev:app` (PWA). The variables are in each app's
`.env.example`: for api and the admin panel copy them to `.env.local` (`services/api/.env.local`,
`apps/admin/.env.local`), web and landing work on the local defaults. The Next.js ports are hardwired in `package.json`
(`next dev --port`), the PWA uses `strictPort` in `vite.config.ts`: a second environment alongside on the same ports
will not start. `pnpm infra:up` already brings up the agent mock on 8080, so a separate `pnpm dev:agent-mock` would
collide with it.

## Sign-in

- **Anonymous:** consent screen → "Начать" (`POST /api/auth/device`).
- **By email:** the codes arrive in Mailpit: `curl -s 'http://127.0.0.1:8026/api/v1/messages?limit=5'`, then
  `curl -s http://127.0.0.1:8026/api/v1/message/<ID>`; UI — `http://localhost:8026`.
- **Admin panel:** the email from `ADMIN_EMAILS` (`admin@ryadom.local` in the example), the code from the email in
  Mailpit.

## The real agent

Without model keys — template replies and local speech synthesis (needs `espeak-ng`):

```bash
cd agent && uv sync
AGENT_INTERNAL_TOKEN=local TTS_MODE=espeak LLM_MODE=template uv run uvicorn app.main:app --port 8001
```

Point api at it: `AGENT_API_URL=http://127.0.0.1:8001`, `AGENT_API_TOKEN=local`. With models — `LLM_MODE=proxy` with
`LLM_BASE_URL` and `AGENT_API_TOKEN`, speech-to-speech — `VOICE_PIPELINE=gemini_live` with `GEMINI_*` (through the
relay); the keys are issued by the administrator, and every turn spends the program's money. All settings are in
`agent/.env.example` and `agent/README.md`.

Voice without a browser:

```bash
uv run python scripts/smoke.py --url http://127.0.0.1:8001 --token local --voice female --wav reply.wav
uv run python scripts/live_smoke.py --url http://127.0.0.1:8001 --token <token> --pcm-dir <PCM 16 kHz> --wav-dir <destination>   # gemini_live
```

## Checks before a PR

During a task it is enough to check the packages you changed and those that depend on them (Turborepo computes that
from the diff against main; typecheck results are then taken from its cache):

```bash
cd app && pnpm exec turbo run typecheck test --filter='...[origin/main]'
```

The whole set — before submitting:

```bash
cd app
pnpm typecheck
pnpm test                                     # core and api use PostgreSQL :55433 (ryadom_test, ryadom_test_api)
pnpm exec prettier --check <changed files>    # pnpm lint does nothing: there are no lint scripts in the packages

cd agent
uv sync && timeout 900 uv run pytest -q -p no:cacheprovider -o faulthandler_timeout=120
uvx ruff check --select F app tests           # ruff is not part of the agent environment
```

- The tests need a database: `pnpm infra:up` or your own PostgreSQL with `dev/postgres-init.sql` and
  `DATABASE_URL_TEST=…/ryadom_test DATABASE_URL_TEST_API=…/ryadom_test_api pnpm test`.
- The agent's pytest works without network and models (about 2.5 minutes, ~600 tests). The timeout is mandatory:
  `test_ws.py` occasionally hangs, `test_live.py` occasionally fails with `CancelledError` — rerun before fixing.

## Pitfalls

- **Windows:** Python output — `PYTHONUTF8=1`; the output of `wsl.exe` may contain NULs (`| tr -d '\0'`); WSL paths from
  Git Bash — `MSYS_NO_PATHCONV=1`. CRLF warnings are expected: `.gitattributes` keeps LF.
- **Busy ports** mean someone's environment from a neighboring worktree. Do not stop other people's processes without
  asking: bring up your own on shifted ports.
- **People's dialogs** must not go into tests and fixtures: only synthetic phrases.

Related: [[e2e]] — end-to-end tests and browser checks; [[commit]] — what to check before a commit.
