## 1. Агент

- [x] 1.1 Код причины и строка отказа: `agent/app/core/reasons.py`, `agent/app/core/failure.py`, поля в журнале сессии и соединителей. Приёмка: `tests/test_failures.py` — коды причин, поля строки, отсутствие текста вендора.
- [x] 1.2 Метрики `agent_component_errors_total` и `agent_pipeline_fallbacks_total`, учёт в `FallbackConnector`, `FallbackTts`, соединителях и сессии. Приёмка: сценарии «Отказ на пути Сбера» и «Переход на запасной путь» в `tests/test_failures.py` и `tests/test_live_recovery.py`.
- [x] 1.3 Кадр `component` несёт `pipeline` и `reason`. Приёмка: `tests/test_components.py`, `tests/test_live_scenarios.py` (контракт кадров).

## 2. Шлюз api

- [x] 2.1 `pipeline` и `reason` из закрытых списков в `component_called`; `pipeline` в строках журнала диалога. Приёмка: «Событие аналитики с путём и причиной» и «Посторонние значения» в `app/services/api/test/dialogs.test.ts`.

## 3. Манифесты и документация

- [x] 3.1 NetworkPolicy `prometheus-allow-egress-scrape`: `:15090` в namespace `agent`. Приёмка: diff манифеста; применение — только после одобрения человека.
- [x] 3.2 Обновить скилл `logs` и `docs/analytics.md`. Приёмка: поля, метрики и запросы совпадают с кодом.

## 4. Проверка

- [x] 4.1 `uv run pytest` в `agent/`, typecheck и `vitest run test/dialogs.test.ts` в `app/services/api`. Интерфейс не менялся: скриншоты не требуются.
- [ ] 4.2 После выката (с одобрения человека): `agent_*` видны в Prometheus, `istio-proxy` агента `up=1`; строка отказа с полями видна в Loki.

## 5. Архив
