---
name: logs
description: Читать логи и метрики прода «Рядом» и следить за ним — kubectl logs подов (agent, app-api и остальных), Loki (LogQL за 7 дней), Prometheus (PromQL, метрики агента), /health и /metrics агента, Langfuse. Использовать при вопросах «что в логах», «какие ошибки на проде», «почему упало», «почему агент молчал», «сколько ошибок квоты», «последи за продом после выката», при разборе инцидентов и привязке ошибки к диалогу или человеку.
---

# Логи и мониторинг прода

Кластер один, Timeweb `twc-sber500`, окружение только prod. Приложения пишут в stdout, Alloy собирает это в Loki,
метрики собирает Prometheus. Наружу ничего не опубликовано: доступ только `kubectl logs` и `port-forward`. Устройство
стека — `k8s/README.md`, раздел «Мониторинг».

## Доступ

`kubectl` ниже — команда к кластеру на этой машине; чем она подключается (kubeconfig, обёртка), знает администратор.
Скрипт скилла берёт её из `RYADOM_KUBECTL_ADMIN` (по умолчанию просто `kubectl`).

| Где | developer | admin |
|---|---|---|
| логи и port-forward в `agent`, `backend`, `ryadom-db`, `infra` | да | да |
| `prod` (app-api, app-web, app-admin, app-landing, app-pwa) | нет, даже чтения | да |
| `monitoring` (Loki, Prometheus, Grafana) | нет | да |
| `exec` в поды | нигде | да |

По умолчанию — developer. **admin — только после явного «да» человека на конкретное чтение** (логи `prod`, Loki,
Prometheus): одним сообщением скажи, что прочитаешь и за какое окно, и ничего не меняй.

## Где что

| ns | Deployment | `-c` | Что в журнале |
|---|---|---|---|
| prod | app-api | api | JSON: `level`, `time`, `msg`, `component`, `userId`, `dialogId`, `codec` |
| prod | app-web, app-admin, app-landing | web, admin, landing | Next.js |
| prod | app-pwa | pwa | nginx |
| agent | agent | agent | текст: `dialog started`, `socket opened/closed`, `first sound`, `live timeline`, `live usage`, `WARNING` |
| agent | cognee | cognee | память агента |
| infra | langfuse-web | — | трассировка LLM (UI, не журнал) |

Всегда указывай `-c`: в подах с сайдкаром Istio `--all-containers` подмешивает шум `istio-proxy`.

## kubectl logs

```bash
kubectl -n agent logs deploy/agent -c agent --since=30m --timestamps > agent.log
kubectl -n prod logs deploy/app-api -c api --since=10m | grep -E '"level":"(warn|error)"'      # admin
kubectl -n agent logs deploy/agent -c agent --since=20m | grep -cE 'socket opened|dialog started'  # живые разговоры
```

- Отдаёт только живой под. У агента стратегия `Recreate`: после выката журнал прежнего пода есть только в Loki.
- Без `--since` или `--tail` команда идёт долго; час журнала агента под нагрузкой весит около 8 МБ, поэтому выгружай в
  файл вне репозитория и разбирай скриптом.

## Loki (7 дней)

```bash
.claude/skills/logs/scripts/monitoring.py loki '{namespace="agent",container="agent"} |~ "WARNING|ERROR|Traceback"' 2h
.claude/skills/logs/scripts/monitoring.py loki '{namespace="prod",container="api"} |= "<dialogId>"' 2026-10-14T10:00:00Z 2026-10-14T11:00:00Z
.claude/skills/logs/scripts/monitoring.py loki 'sum(count_over_time({namespace="agent",container="agent"} |= "exceeded your current quota" [5m]))' 6h
```

Скрипт поднимает port-forward к `svc/loki` (admin), спрашивает `query_range` и печатает строки `время  под  строка`
(метрики LogQL — рядами). `--raw` — исходный JSON, `--limit N` — потолок строк (5000 у Loki).

- Метки: `namespace`, `container`, `pod`, `app`, `service_name`, `job`, `instance`.
- Журнал api — JSON: `{namespace="prod",container="api"} | json | level="error"`; уровни по минутам —
  `sum by (level) (count_over_time({namespace="prod",container="api"} | json | __error__="" [1m]))`.
- Шум агента отсекается так: `!= "GET /" != "POST /" != "connection open" != "WebSocket /"`.
- Длинные окна режь кусками по 30 минут: больше 5000 строк Loki не отдаст. Скобку в регулярке пиши `[)]`, не `\\)`.

## Prometheus (14 дней)

```bash
.claude/skills/logs/scripts/monitoring.py prom 'sum by (purpose, result) (increase(agent_gemini_opens_total[1h]))'
.claude/skills/logs/scripts/monitoring.py prom 'sum by (response_code) (rate(istio_requests_total{reporter="destination",destination_service_name="app-api"}[5m]))' 3h --step 300
```

Без окна — текущее значение, с окном — ряд с шагом `--step` секунд.

| Что | PromQL |
|---|---|
| рестарты | `kube_pod_container_status_restarts_total{namespace=~"prod\|agent"}` |
| готовность | `kube_pod_status_ready{namespace=~"prod\|agent",condition="true"}` |
| память и CPU | `container_memory_working_set_bytes{namespace="agent",container="agent"}`, `rate(container_cpu_usage_seconds_total{namespace="agent",container="agent"}[5m])` |
| WebSocket-апгрейды к api | `sum(rate(istio_requests_total{reporter="destination",destination_service_name="app-api",response_code="101"}[5m]))` |
| бюджет Gemini | `agent_gemini_tpm_window_tokens`, `agent_gemini_tpm_limit_tokens`, `agent_gemini_budget_level`, `increase(agent_gemini_quota_errors_total[1h])` |
| расход моделей | `agent_model_usage_total` (метки `model`, `task`, `direction`, `modality`, `unit`), `agent_component_calls_total` |
| база и память агента | `agent_dialog_db_errors_total`, `agent_memory_*`, `process_resident_memory_bytes` |

Полный список метрик агента и что они значат — `agent/README.md`. Grafana есть (`svc/prometheus-grafana`), но для
чтения хватает этих двух API.

## Агент напрямую (developer)

```bash
kubectl -n agent port-forward deploy/agent 18001:8001 & pf=$!; sleep 5
curl -s localhost:18001/health/ready; curl -s localhost:18001/version
curl -s localhost:18001/metrics | grep '^agent_'
kill $pf
```

`/health/ready` показывает конвейер (`pipeline`), озвучку (`tts`), хранилище диалогов (`dialogs`: `postgres` — норма,
`memory` — база не открылась) и режим памяти (`memory`).

## Langfuse

`kubectl -n infra port-forward svc/langfuse-web 3000:3000` (developer) → `http://localhost:3000`, вход у администратора.
Тексты реплик в трассы не пишутся (`LANGFUSE_TRACE_TEXT=false`), по токенам Langfuse — источник правды; стоимость там 0,
цены моделей не заданы. Ключи проекта Langfuse есть только в окружении пода агента: из пода их не выноси, read-only
скрипт к его API запускай в самом поде (`kubectl exec -i -n agent deploy/agent -c agent -- python - < script.py`, admin).

## Ошибка → диалог → человек

- В журнале api есть `userId` и `dialogId`; путь сокета агента — `/v1/users/<userId>/dialogs/<dialogId>/ws`.
- `dialog_id` один и тот же в PostHog, в журналах и в базе агента (скиллы `analytics` и `db`).
- Порядок: найти `dialogId` (событие PostHog или строка базы) → Loki `|= "<dialogId>"` в `agent` и `prod` за окно разговора.

## После выката

1. `kubectl -n <ns> rollout status deploy/<имя> --timeout=300s`; под Ready, рестартов 0.
2. Агент: в журнале старта `dialog db opened`, `agent started: pipeline=… memory=…`,
   `прогрев озвучки закончен: озвучено N, не удалось 0`; затем `grep -E ' (WARNING|ERROR|CRITICAL) |Traceback'`.
3. api: `--since=10m` без `"level":"error"`, есть «Redis подключён».
4. `/health/ready` и `/version` агента; снаружи `curl -sI https://xn----htbtgjker8b3a2c.xn--p1ai/api/health`, `/app`, `/pwa/`.
5. Автоматические проверки — `k8s/postdeploy` (скилл `deploy`).
6. Долгое наблюдение — фоновой командой с опросом раз в 5–10 минут; в чат или задачу только аномалии и итог.

## Грабли

- **Время.** Журналы, Loki и Prometheus в UTC, люди говорят по Москве (UTC+3).
- **Хранение.** Loki — 7 дней, Prometheus — 14 дней или 3 ГБ, `kubectl logs` — только живой под.
- **Разговоры людей.** Тексты реплик в журнал не пишутся; если что-то личное всё же попалось, в отчёты, задачи,
  коммиты и PR оно не идёт. Выгрузки журналов — только вне репозитория.
- **Шум, а не тревога:** строки `Forwarding`/`Handling` от port-forward, `GET /health`, `fsnotify … too many open files`
  у istio-proxy, штатные `live timeline`, `live usage`, `first sound`.
- **Сетевой сбой — не ответ.** Тайм-аут TLS к API кластера или к реестру (бывает за VPN) не значит, что ресурса нет.
- **`ImagePullBackOff` с `no match for platform`** — образ собран не под `linux/amd64` (скилл `deploy`).

Связано: [[deploy]] — что и когда выкатывалось; [[db]] — данные по `userId` и `dialogId`; [[analytics]] — события PostHog.
