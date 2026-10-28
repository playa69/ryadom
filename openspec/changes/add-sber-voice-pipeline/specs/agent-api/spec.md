## MODIFIED Requirements

### Requirement: Служебные эндпоинты
Агент SHALL предоставлять `GET /health` (liveness: всегда `{ "status": "ok" }`, пока жив процесс), `GET /health/ready`, `GET /version` и `GET /metrics` (метрики Prometheus). `GET /health/ready` MUST отвечать `200` всегда и перечислять выбранные компоненты: `status` (`ok`), `pipeline` (имя соединителя Gemini Live или `none`), `voicePipeline` (путь разговоров, для которых API не передал путь: `sber` — если у агента настроен прокси, иначе `gemini`), `tts` (озвучка фраз или `none`), `llm` (фоновая модель итогов и заметок или `none`), `dialogs` (`postgres` — диалоги в PostgreSQL и переживают перезапуск, `memory` — только в памяти процесса: хранилище не задано или не открылось), `memory` (`on` — память настроена, `unavailable` — не настроена, `off` — пока не создана). Отказ модели или озвучки не делает агента неготовым: он отвечает текстом, а итоги и заметки откладываются. Служебные эндпоинты MUST NOT требовать внутренний токен, MUST NOT попадать в access-журнал и MUST NOT быть доступны извне кластера.

Поверхности: agent

#### Scenario: Liveness
- **WHEN** запрашивается `GET /health`
- **THEN** ответ `200` `{ "status": "ok" }` без токена

#### Scenario: Readiness показывает компоненты
- **WHEN** запрашивается `GET /health/ready` у исправного агента с базой диалогов
- **THEN** ответ `200` с полями `pipeline`, `voicePipeline`, `tts`, `llm`, `dialogs: "postgres"` и `memory`

#### Scenario: База диалогов не открылась
- **WHEN** хранилище диалогов не открылось при старте агента
- **THEN** агент отвечает на запросы, диалоги живут в памяти процесса, `GET /health/ready` содержит `"dialogs": "memory"`

#### Scenario: Журнал доступа
- **WHEN** оркестратор опрашивает `/health`, `/version` или `/metrics`
- **THEN** эти обращения не попадают в access-журнал агента

