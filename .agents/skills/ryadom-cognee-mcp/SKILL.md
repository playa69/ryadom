---
name: ryadom-cognee-mcp
description: "Подключение к командному Cognee MCP проекта Рядом (twc-sber500) — общая память команды. Подключение через env-переменные COGNEE_MCP_USER/COGNEE_MCP_PASS без секретов в конфигах. Правила: факты проекта писать в dataset ryadom, recall перед началом работы, секреты не индексировать. Используй когда нужно подключить MCP, сохранить/найти знание команды или продиагностировать подключение."
whenToUse: Когда подключаешь Cognee MCP в этом репо, настраиваешь mcp.json у нового члена команды, сохраняешь/ищешь командные знания (remember/recall), или recall/remember не работают
---

# Командная память Рядом — Cognee MCP

Cognee — общая память проекта **Рядом** (кластер `twc-sber500`, см. скилл
`ryadom-twc-cluster`). Команда работает в **одном контексте**: общий
Cognee MCP-сервер, общий датасет `ryadom`. Локальный docker и Cognee Cloud
не используются.

Все MCP-клиенты ходят под одним сервисным аккаунтом, поэтому данные всех
членов команды ложатся в одни датасеты — это и есть общий контекст.

## Подключение (онбординг разработчика)

Принцип: **в конфигах — только имена переменных, креды — в окружении разработчика.**

1. Получить basic-auth креды у того, кто деплоил MCP (пароль формата `XXXX-XXXX-XXXX`).
2. Экспортировать в `~/.zshrc` (или `.env` + direnv):
   ```bash
   export COGNEE_MCP_USER="mcp"
   export COGNEE_MCP_PASS="XXXX-XXXX-XXXX"   # спросить у команды
   ```
3. Сервер уже прописан в корневом `.mcp.json` репозитория (имя `cognee`) —
   подхватится автоматически. stdio-запись запускает `npx mcp-remote` при старте
   сессии: нужен node/npx, shell подставит креды из env.
4. Перезапустить сессию клиента (`/new` или рестарт) — MCP грузится только при старте.
5. Проверить: вызвать `get_client_info_json` — должен вернуть агентский датасет.
   Быстрая проверка без IDE:
   ```bash
   curl -N -u "$COGNEE_MCP_USER:$COGNEE_MCP_PASS" https://mcp.fantomas404.ru/sse
   # ожидаем: event: endpoint / data: /messages/?session_id=...
   # 401 = неверные или отсутствующие COGNEE_MCP_USER/COGNEE_MCP_PASS
   ```

Содержимое `.mcp.json` (источник истины — файл в корне репо):

```json
{
  "mcpServers": {
    "cognee": {
      "command": "bash",
      "args": ["-c", "BASIC=$(printf '%s' \"$COGNEE_MCP_USER:$COGNEE_MCP_PASS\" | base64); exec npx -y mcp-remote \"https://mcp.fantomas404.ru/sse\" --header \"Authorization: Basic $BASIC\""],
      "startupTimeoutMs": 180000,
      "toolTimeoutMs": 300000
    }
  }
}
```

Почему не креды в URL (`https://user:pass@host/sse`): mcp-remote (Node fetch/undici)
отвергает такие URL — `TypeError: Request cannot be constructed from a URL that includes credentials`.

Другие клиенты:
- **Claude Code** — тот же корневой `.mcp.json`; поддерживает `${VAR}` и native SSE
  без mcp-remote: `"url": "https://${COGNEE_MCP_USER}:${COGNEE_MCP_PASS}@mcp.fantomas404.ru/sse"`.
- **Cursor** — GUI не наследует shell env; креды только в user-level `~/.cursor/mcp.json` (вне репо).

## Инструменты (префикс `mcp__cognee__*`)

Деплой с `COGNEE_MCP_TOOL_MODE=all` — 10 инструментов:

- `remember(data, dataset_name?, session_id?)` — сохранить. Без `session_id` —
  полный пайплайн add + cognify (граф знаний, долго). С `session_id` — быстрый
  session-кэш на сессию, без извлечения сущностей.
- `recall(query, datasets?, search_type?, top_k?)` — поиск по памяти, авто-роутинг
  стратегии. `search_type`: `GRAPH_COMPLETION`, `RAG_COMPLETION`, `CHUNKS`,
  `SUMMARIES`, `TEMPORAL` и др.
- `forget(dataset?, everything?)` — деструктивно, подтверждать у пользователя.
- Датасеты: `list_datasets_json`, `list_dataset_data_json`, `create_dataset_json`,
  `get_client_info_json` (клиент + датасет по умолчанию — проверка живости).
- Workspace UI: `open_cognee_workspace`, `upload_file_ui`, `visualize_graph_ui`.

## Правила работы в общем контексте

- **Датасет проекта — `ryadom`.** Все факты, решения, находки по проекту Рядом
  писать с `dataset_name="ryadom"` (создаётся на лету). Личные черновики —
  в дефолтный агентский датасет или с `session_id` (session-кэш).
- **Recall перед работой:** для вопросов «как устроено / что решили / где лежит»
  сначала `recall(query=..., datasets="ryadom")` — дешевле обхода кодбазы.
  Но recall отдаёт синтез, не точный код: для правок всегда читать реальные файлы.
- **Remember после работы:** нетривиальные решения, грабли, договорённости —
  `remember(data=..., dataset_name="ryadom")`. Писать фактами, со ссылками
  на файлы/поды/даты.
- Актуальный состав датасетов — только через `list_datasets_json`, не из заметок.
- Чужие датасеты (не `ryadom`) не трогать без запроса — на сервере могут жить
  и другие проекты.

## Известные ловушки

- MCP `remember` может таймаутить на клиенте (-32001), но сервер при этом
  ОБРАБАТЫВАЕТ запрос. Прежде чем ретраить — проверить датасет, иначе дубли.
- `HTTP 404: Could not find session` — протухла SSE-сессия mcp-remote
  (рестарт пода/ingress). Лечится перезапуском сессии клиента.
- MCP recall насильно роутит в completion-стратегии, игнорируя `search_type=CHUNKS`;
  для сырых чанков — REST `POST /api/v1/search`.
- Дедуп по хешу контента: повторная заливка неизменённого файла пропускается.
- Индексация кода: `.py` → CODE-маршрут (быстро, но слабый семантический поиск);
  суффикс `.txt` в filename → TEXT-маршрут (чанки + эмбеддинги, медленно, качественно).

## Правила безопасности

- Никогда не индексировать `.env`, секреты, kubeconfig'и, ключи (`admin-kubeconfig.yaml`,
  `registry-pusher-key.json` и т.п. в этом репо — табу для remember/add).
- Креды MCP — только env `COGNEE_MCP_USER`/`COGNEE_MCP_PASS`, не хардкодить,
  не коммитить, не индексировать.

## Диагностика

- 401 на SSE — нет/неверны env-креды в окружении, откуда запущен клиент.
- 502/503 — под прогревается (3–4 мин) или упал; логи смотрит тот, кто админит деплой.
- MCP отвечает, но инструменты падают с 401 — протух сервисный токен MCP→API;
  эскалация к админу деплоя.
