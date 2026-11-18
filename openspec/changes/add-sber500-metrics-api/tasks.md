# Tasks: add-sber500-metrics-api

## 1. Контракт и код дашборда

- [x] 1.1 Endpoint `GET /api/v1/metrics/daily` в `dashboard/app.py`: валидация `date_from`/`date_to` (обязательные, `YYYY-MM-DD`, `from ≤ to`, ≤ 90 дней, `date_to` не в будущем → 400 `{"error": …}`)
  Приёмка: `parse_metrics_range` покрыта тестами, включая границу ровно 90 дней.
- [x] 1.2 Bearer-аутентификация (`METRICS_API_TOKEN`, `hmac.compare_digest`, 401) и лимит 30 запросов/мин на IP (429)
  Приёмка: тесты `test_metrics_api_token`, `test_metrics_api_rate_limit_allows_up_to_limit_per_minute` зелёные.
- [x] 1.3 Ответ по ТЗ: `startup_id`, `timezone`, `generated_at`, `data[]` с полями `date`, `dau`, `llm_requests`, `tool_requests`, `total_users`, `new_users`, `is_final`; целые числа; нули за дни без данных; `total_users` без провала (итог раньше диапазона / последний известный); источники — снимки + предварительные текущие сутки, `daily_active_account` наружу не отдаётся; кэш ответа 15 минут
  Приёмка: `test_metrics_api_payload_shape_and_totals_chain`, `test_metrics_api_total_start_keeps_cumulative_total`, `test_metrics_api_combines_snapshots_and_preliminary_today` зелёные; сквозной smoke локально: 200/400/401/429/404 с JSON.

## 2. Манифесты и секреты

- [x] 2.1 `k8s/dashboard/02-deployment.yaml`: env `METRICS_API_TOKEN` из `dashboard-secrets`; сервер не стартует без токена
  Приёмка: `kubectl diff` на выкате показывает только env, тег образа и правило HTTPRoute.
- [x] 2.2 `k8s/dashboard/04-httproute.yaml`: match `PathPrefix /api/v1/metrics` → dashboard (длиннее `/api` app-api)
  Приёмка: после выката живой запрос с токеном доходит до дашборда (не до app-api).

## 3. Документация

- [x] 3.1 `dashboard/README.md`: раздел «Metrics API для системы сбора Sber500» (контракт, источники, строка определений для организаторов)
- [x] 3.2 `k8s/dashboard/README.md`: ключ `METRICS_API_TOKEN` в таблице Secret'а, порядок выката 0.2.3 с проверками

## 4. Проверка

- [x] 4.1 `uv run --no-project --python 3.12 --with pytest pytest -q tests` — все тесты зелёные
- [x] 4.2 `uv run --no-project --with ruff ruff check --line-length 130 .` — чисто
- [ ] 4.3 После выката (по «да» владельца): `curl` с токеном — формат по ТЗ, числа за пересечение совпадают с `/dashboard/api`, без токена — 401; зафиксировать в отчёте

## 5. Выкат

- [ ] 5.1 Запись `METRICS_API_TOKEN` в Lockbox `ryadom-app-secrets` (≥32 символов) и пересборка `dashboard-secrets` (`--dry-run=server` сначала)
- [ ] 5.2 Образ `dashboard:0.2.3` (linux/amd64) → cr.yandex, rollout Deployment и HTTPRoute (порядок — `k8s/dashboard/README.md`, выкат — только после явного «да»)

## 6. Архив

- [ ] 6.1 После выката: `validate add-sber500-metrics-api --strict`, `archive add-sber500-metrics-api --yes`, папку `archive/` в git не класть, коммит со спекой
