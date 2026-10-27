---
name: local-dev
description: Поднять «Рядом» локально и прогнать проверки — PostgreSQL, Redis, Mailpit и мок агента в Docker, dev-серверы api, web, landing, admin и PWA, настоящий агент на Python (шаблоны или модели), вход анонимно, по коду из письма и в админку, typecheck, тесты app, pytest агента, ruff. Использовать при просьбах «запусти локально», «подними стенд», «проверь, что работает», «прогони тесты», «почему тесты падают», перед коммитом и перед e2e.
---

# Локальный запуск и проверки

Монорепозиторий `app/` (pnpm + Turborepo, Node 24), агент `agent/` (Python 3.12, uv), backend `backend/` (Python,
приложением не вызывается). Быстрый старт — README, раздел «Быстрый старт»; здесь — то, что на нём спотыкалось.

Docker нужен для инфраструктуры. На Windows он живёт в WSL: `app/scripts/docker.mjs` сам переходит на `wsl docker`,
когда в Windows docker нет, поэтому `pnpm infra:up` работает и оттуда.

## Стенд разработки

```bash
cd app
pnpm install --frozen-lockfile   # в свежем worktree; несколько агентов в одном каталоге — node scripts/with-lock.mjs pnpm install
pnpm infra:up                    # PostgreSQL :55433, Redis :56379, Mailpit :1026 (SMTP) и :8026 (UI), мок агента :8080
pnpm db:migrate
pnpm dev                         # landing :3000, admin :3001, api :3002, web :3003, PWA (vite) :5174
```

Части по отдельности: `pnpm dev:api`, `dev:web`, `dev:admin`, `dev:landing`, `dev:app` (PWA). Переменные — в
`.env.example` каждого приложения: для api и админки скопируй их в `.env.local` (`services/api/.env.local`,
`apps/admin/.env.local`), web и landing работают на локальных значениях по умолчанию. Порты Next.js зашиты в
`package.json` (`next dev --port`), PWA — `strictPort` в `vite.config.ts`: второй стенд рядом на тех же портах не
встанет. `pnpm infra:up` уже поднимает мок агента на 8080, отдельный `pnpm dev:agent-mock` с ним столкнётся.

На машине агента (Multica) всё это делает `app-up`: своя база, свои порты прогона, адреса в выводе.

## Вход

- **Анонимно:** экран согласий → «Начать» (`POST /api/auth/device`).
- **По почте:** коды приходят в Mailpit: `curl -s 'http://127.0.0.1:8026/api/v1/messages?limit=5'`, затем
  `curl -s http://127.0.0.1:8026/api/v1/message/<ID>`; UI — `http://localhost:8026`.
- **Админка:** почта из `ADMIN_EMAILS` (`admin@ryadom.local` в примере), код из письма в Mailpit.

## Настоящий агент

Без ключей моделей — шаблонные ответы и локальная озвучка (нужен `espeak-ng`):

```bash
cd agent && uv sync
AGENT_INTERNAL_TOKEN=local TTS_MODE=espeak LLM_MODE=template uv run uvicorn app.main:app --port 8001
```

api направить на него: `AGENT_API_URL=http://127.0.0.1:8001`, `AGENT_API_TOKEN=local`. С моделями —
`LLM_MODE=proxy` с `LLM_BASE_URL` и `AGENT_API_TOKEN`, речь в речь — `VOICE_PIPELINE=gemini_live` с `GEMINI_*` (через
релей); ключи выдаёт администратор, и каждый ход тратит деньги программы. Все настройки — `agent/.env.example` и
`agent/README.md`.

Голос без браузера:

```bash
uv run python scripts/smoke.py --url http://127.0.0.1:8001 --token local --voice female --wav reply.wav
uv run python scripts/live_smoke.py --url http://127.0.0.1:8001 --token <токен> --pcm-dir <PCM 16 кГц> --wav-dir <куда>   # gemini_live
```

## Проверки перед PR

По ходу задачи хватает пакетов, которые ты менял, и тех, что от них зависят (Turborepo считает это по диффу с main;
результаты typecheck при этом берутся из его кэша):

```bash
cd app && pnpm exec turbo run typecheck test --filter='...[origin/main]'
```

Весь набор — перед сдачей:

```bash
cd app
pnpm typecheck
pnpm test                                     # core и api ходят в PostgreSQL :55433 (ryadom_test, ryadom_test_api)
pnpm exec prettier --check <изменённые файлы>  # pnpm lint ничего не делает: lint-скриптов в пакетах нет

cd agent
uv sync && timeout 900 uv run pytest -q -p no:cacheprovider -o faulthandler_timeout=120
uvx ruff check --select F app tests           # ruff в окружение агента не входит, pre-commit проверяет только backend/
```

- Тестам нужна база: `pnpm infra:up` или свой PostgreSQL с `dev/postgres-init.sql` и
  `DATABASE_URL_TEST=…/ryadom_test DATABASE_URL_TEST_API=…/ryadom_test_api pnpm test`. На машине агента —
  `app-up infra`, затем `eval "$(app-up env)"`.
- pytest агента обходится без сети и моделей (около 2,5 минут, ~600 тестов). Тайм-аут обязателен: `test_ws.py`
  изредка виснет, `test_live.py` изредка падает с `CancelledError` — повтори прежде, чем чинить.
- backend: `cd backend && uv run pytest` ждёт PostgreSQL на 127.0.0.1:15432 (база `backend_test`, пользователь
  `developer`) — это port-forward к кластеру; хуки — `pre-commit install` (ruff по `backend/`).

## Грабли

- **Windows:** вывод Python — `PYTHONUTF8=1`; у `wsl.exe` в выводе бывают NUL (`| tr -d '\0'`); пути WSL из Git Bash —
  `MSYS_NO_PATHCONV=1`. Предупреждения CRLF ожидаемы: `.gitattributes` держит LF.
- **Занятые порты** — чей-то стенд из соседнего worktree. Не останавливай чужое без спроса: подними свой на сдвинутых
  портах.
- **Разговоры людей** в тесты и фикстуры не переносить: только синтетические фразы.

Связано: [[e2e]] — сквозные тесты и проверка в браузере; [[commit]] — что проверить перед коммитом.
