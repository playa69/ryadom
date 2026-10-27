---
name: local-dev
description: Поднять «Рядом» локально и прогнать проверки — свой стенд worktree (слот портов, PostgreSQL, Redis, Mailpit и мок агента в Docker, dev-серверы api, web, landing, admin и PWA), настоящий агент на Python (шаблоны или модели), вход анонимно, по коду из письма и в админку, typecheck, тесты app со своей базой на прогон, pytest агента, ruff. Использовать при просьбах «запусти локально», «подними стенд», «проверь, что работает», «прогони тесты», «почему тесты падают», «порт занят», перед коммитом и перед e2e.
---

# Локальный запуск и проверки

Монорепозиторий `app/` (pnpm + Turborepo, Node 24) и агент `agent/` (Python 3.12, uv). Быстрый старт — README,
раздел «Быстрый старт»; здесь — то, что на нём спотыкалось.

Docker нужен для инфраструктуры. На Windows он живёт в WSL: `app/scripts/docker.mjs` сам переходит на `wsl docker`,
когда в Windows docker нет, поэтому все команды ниже работают и оттуда.

## Стенд worktree

Агенты работают в разных worktree на одной машине. У каждого worktree свой **стенд**: `STAND_ID` (имя каталога
worktree; `STAND_ID=…` в окружении переопределяет) и **слот** — номер N, который даёт порты, имена compose-проектов и
метки контейнеров. Слот берётся при первой команде `stand:*`, `pnpm test` или `pnpm e2e` и закрепляется в
`app/.stand.json` (в git не попадает); реестр слотов всей машины — `%LOCALAPPDATA%\ryadom-stands\slots\N.json`
(создаётся через mkdir, два агента не возьмут один номер). При выборе слота каждый порт пробно занимается на
127.0.0.1: занятый или зарезервированный Windows (`netsh int ipv4 show excludedportrange protocol=tcp`) слот
пропускается.

Все команды — из `app/` любого worktree:

```bash
pnpm stand:up [--only api,web,…] [--infra-only] [--e2e]   # поднять стенд (по умолчанию всё; --e2e — стек для e2e)
pnpm stand:env [--shell|--ps|--json]                       # адреса и переменные стенда (pnpm --silent stand:env --shell | eval)
pnpm stand:down [--release]                                # остановить своё; --release ещё и вернуть слот
pnpm stand:ls                                              # все стенды машины: слот, что запущено, давно ли виден
pnpm stand:gc [--dry-run]                                  # убрать слоты исчезнувших или давно простаивающих worktree
pnpm stand:run -- <команда>                                # команда с переменными стенда (например, db:migrate)
pnpm stand:lock <имя> -- <команда>                         # команда под замком всей машины (эмулятор Android)
pnpm test                                                  # юнит-тесты, у каждого прогона своя база
pnpm e2e [-- <аргументы playwright>]                       # сквозные тесты на портах стенда (скилл e2e)
pnpm evidence <TASK> [спеки]                               # e2e со скриншотом на шаг (скилл screenshots)
```

`--only` принимает `infra` (все четыре контейнера) или `postgres`, `mailpit`, `redis`, `mock`, `api`, `web`,
`landing`, `admin`, `pwa`. `stand:up` применяет миграции, запускает dev-серверы фоном (логи — `.stand/<id>/logs/`),
ждёт их health и печатает адреса. `stand:down` снимает серверы деревом процессов (`taskkill /T`) и контейнеры по
метке `com.ryadom.stand`.

### Карта портов

dev = `20000 + 100·N + k`, e2e = `20000 + 100·N + 50 + k` (слот N ≥ 1, до 290: всё ниже 49152, где ОС берёт
эфемерные порты). Слот 0 — прежние фиксированные порты; без `.stand.json` и переменных всё работает как раньше.

| k | что | dev, слот 0 | e2e, слот 0 |
|---|---|---|---|
| 0 | landing | 3000 | 3100 |
| 1 | admin | 3001 | — |
| 2 | api | 3002 | 3102 |
| 3 | web | 3003 | 3103 |
| 4 | PWA | 5174 (vite) | 3104 (`vite preview`) |
| 5 | мок агента | 8080 | 8081 |
| 6 | Mailpit, UI | 8026 | 8027 |
| 7 | Mailpit, SMTP | 1026 | 1027 |
| 8 | PostgreSQL | 55433 | 55434 |
| 9 | Redis | 56379 | — |
| 10 | агент на Python | 8001 | — |
| 11 | drizzle studio | 4983 | — |

Слот 0 — ручной стенд человека (`pnpm infra:up`, `pnpm dev`, `db:migrate`): агент его не берёт, но может указать
явно, `STAND_SLOT=0`.

Compose-проекты — `ryadom-<id>-dev`, `-e2e`, `-full` (`ryadom-` в начале id не удваивается), у контейнеров, томов и
сетей метки `com.ryadom.stand` и `com.ryadom.worktree`. База dev-стенда агента — в tmpfs (`dev/compose.tmpfs.yaml`):
после `stand:down` от неё ничего не остаётся. Образ мока агента один на машину, тег — хэш `app/dev/agent-mock`:
изменился мок — соберётся новый, нет — не собирается заново. Весь стек из `app/docker-compose.yaml` — на тех же портах
dev (порты `FULL_*`): `pnpm stand:run -- node scripts/docker.mjs compose -p $STAND_PROJECT_FULL up --build`.

## Ручной стенд разработки (слот 0)

```bash
cd app
pnpm install --frozen-lockfile   # в свежем worktree
pnpm infra:up                    # PostgreSQL :55433, Redis :56379, Mailpit :1026 (SMTP) и :8026 (UI), мок агента :8080
pnpm db:migrate
pnpm dev                         # landing :3000, admin :3001, api :3002, web :3003, PWA (vite) :5174
```

Части по отдельности: `pnpm dev:api`, `dev:web`, `dev:admin`, `dev:landing`, `dev:app` (PWA). Переменные — в
`.env.example` каждого приложения: для api и админки скопируй их в `.env.local` (`services/api/.env.local`,
`apps/admin/.env.local`), web и landing работают на локальных значениях по умолчанию. Порты Next.js зашиты в
`package.json` (`next dev --port`), PWA — `strictPort` в `vite.config.ts`: **второй ручной стенд рядом не встанет**.
Поэтому агент в своём worktree поднимает стенд командой `pnpm stand:up`: она запускает серверы на портах слота
напрямую, минуя эти скрипты, и сама подставляет адреса друг друга. `pnpm infra:up` уже поднимает мок агента на 8080,
отдельный `pnpm dev:agent-mock` с ним столкнётся.

## Вход

Адреса — из `pnpm stand:env` (`STAND_URL_*`); ниже порты слота 0.

- **Анонимно:** экран согласий → «Начать» (`POST /api/auth/device`).
- **По почте:** коды приходят в Mailpit: `curl -s "$STAND_URL_MAIL/api/v1/messages?limit=5"`, затем
  `curl -s $STAND_URL_MAIL/api/v1/message/<ID>`; UI — `http://localhost:8026` в слоте 0.
- **Админка:** почта из `ADMIN_EMAILS` (`admin@ryadom.local` в примере), код из письма в Mailpit.

## Настоящий агент

Без ключей моделей — шаблонные ответы и локальная озвучка (нужен `espeak-ng`):

```bash
cd agent && uv sync
AGENT_INTERNAL_TOKEN=local TTS_MODE=espeak LLM_MODE=template uv run uvicorn app.main:app --port 8001   # порт слота: DEV_AGENT_PORT
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
pnpm test                                     # свой PostgreSQL стенда, у каждого прогона своя база (ниже)
pnpm exec prettier --check <изменённые файлы>  # pnpm lint ничего не делает: lint-скриптов в пакетах нет

cd agent
uv sync && timeout 900 uv run pytest -q -p no:cacheprovider -o faulthandler_timeout=120
uvx ruff check --select F app tests           # ruff в окружение агента не входит
```

- **База на прогон.** `pnpm test` берёт слот, поднимает PostgreSQL стенда, если он не отвечает, и запускает turbo.
  Core и api создают базу `ryadom_test_<id>_<pid>` из шаблона `ryadom_tpl_<хэш миграций>` (шаблон строится и мигрируется
  один раз под `pg_advisory_lock`) и удаляют её в конце; упавший прогон оставляет базу, её сметёт следующий прогон того
  же стенда. Два прогона одновременно, даже на одном сервере, друг другу не мешают. Код — `packages/db/src/test-db.ts`.
- `pnpm --filter @ryadom/core test` напрямую берёт сервер из `TEST_DB_ADMIN_URL`, а без неё из `.stand.json`, а без
  него — `localhost:55433` (слот 0). Назвать саму базу тестов нельзя: у каждого прогона она своя.
- Своя инфраструктура без стенда: `pnpm stand:up --infra-only` (или `--only postgres`).
- pytest агента обходится без сети и моделей (около 2,5 минут, ~600 тестов). Тайм-аут обязателен: `test_ws.py`
  изредка виснет, `test_live.py` изредка падает с `CancelledError` — повтори прежде, чем чинить.

## Грабли

- **Windows:** вывод Python — `PYTHONUTF8=1`; у `wsl.exe` в выводе бывают NUL (`| tr -d '\0'`); пути WSL из Git Bash —
  `MSYS_NO_PATHCONV=1`. Предупреждения CRLF ожидаемы: `.gitattributes` держит LF.
- **Занятый порт.** В слоте ≥ 1 его занял не стенд: `pnpm stand:ls`, `netstat -ano`. Чужое не останавливай; свои
  остатки снимает `pnpm stand:down`, брошенные стенды исчезнувших worktree — `pnpm stand:gc`.
- **Два стенда в одном worktree** (разные `STAND_ID`) делят папки сборки `.next`/`dist`: собирай их по очереди.
- **Один Postgres на два прогона** (проверка, что они друг другу не мешают): `STAND_SLOT=1 STAND_ID=a pnpm test` и
  то же с `STAND_ID=b` в двух терминалах; разные `STAND_ID` без `STAND_SLOT` берут разные слоты и разные контейнеры.
- **Разговоры людей** в тесты и фикстуры не переносить: только синтетические фразы.

Связано: [[e2e]] — сквозные тесты и проверка в браузере; [[screenshots]] — снимки экранов и доказательства;
[[commit]] — что проверить перед коммитом.
