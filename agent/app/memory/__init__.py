"""Долговременная память агента: Cognee.

Память человека — его датасет `ryadom_user_<user_id>` в Cognee (`cognee_backend.py`, клиент
`app/clients/cognee.py`): согласие, транскрипты, извлечённый граф. После разговора транскрипт уходит в датасет
(add + cognify), сводка для разговора — поиск по датасету; подробно — agent/README.md «Память».

- `backend` — контракт бэкенда памяти (`MemoryBackend`), его имеют `app.state.memory` и `DialogStore.memory`;
- `errors` — коды ошибок каталога agent-api для REST памяти (`app/api/memory.py`).
"""
