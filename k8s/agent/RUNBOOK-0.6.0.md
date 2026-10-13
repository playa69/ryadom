# Выкат agent 0.6.0 и приложения (api 0.6.0, web 0.6.0, pwa 0.5.0): ранбук

Выкат **в два шага** (решение владельца, 2026-10-13): сначала всё **без памяти** (`MEMORY_MODE: "off"`), потом отдельным деплоем
включается память. Здесь шаги 0–3; в кластер ничего не применяется само, каждое действие под admin-kubeconfig — отдельным «да».

## Что едет

| Часть | Что меняется | Чем рискует |
|---|---|---|
| agent 0.6.0 | схема файла диалогов v1 → v2 при старте (необратимо без копии); память (по умолчанию `off`); расход моделей; бюджет токенов Gemini (`ENFORCE=false`); выгрузка неактивных; возврат памяти процесса; ресурсы 250m/1000m и 256Mi/768Mi; пробы | откат образа на прежнюю версию невозможен без копии файла |
| api 0.6.0 | сжатие озвучки (Opus, μ-law) для клиентов, согласующих кодек; шлюз памяти `/api/memory/*`; лимит CPU 1000m | CPU узла; память api (лимит 384Mi, +20–40 МБ под нагрузкой) |
| web 0.6.0, pwa 0.5.0 | декодеры звука (WebCodecs / WASM), экран «Память» (скрыт, пока агент в режиме `off`), CSP `'wasm-unsafe-eval'` | iOS до 26 и Firefox Android идут через WASM, на реальных устройствах не проверено |

Старые клиенты (без списка кодеков в `hello`) продолжают получать PCM, поэтому порядок «сначала api и агент, потом клиенты» безопасен.

## Шаг 0. До выката (без кластера)

1. PR собран и влит, тесты `agent` и `app` зелёные, e2e локально пройден.
2. Образы собраны и отправлены в реестр (см. `k8s/agent/README.md` и `k8s/app/build-push.sh`): `agent/agent:0.6.0`, `app/api:0.6.0`,
   `app/web:0.6.0` (`--build-arg BASE_PATH=/app`), `app/pwa:0.5.0`. Теги в манифестах уже подняты, **применять манифесты можно только
   после того, как образы лежат в реестре** (иначе под не стартует: ImagePullBackOff).
3. Проверить оплату Gemini: аккаунт оплаты Gemini может сам перейти на предоплату; при нулевом балансе все ключи получат ошибку 402. Откат
   голоса на этот случай: `VOICE_PIPELINE: "cascade"` в `agent-config` и перезапуск агента.

### Сверка с живым кластером (обязательно, read-only)

Кластер мог уйти вперёд от `main`: другие люди выкатывают образы и ключи конфигурации, которых в репозитории нет (13.10 так и вышло:
в кластере уже работал образ `agent:0.5.0`, собранный не из репозитория, а в `agent-config` лежали ключи Langfuse, которых нет в манифестах).

```bash
kubectl -n agent get deploy agent -o jsonpath='{.spec.template.spec.containers[0].image}'   # записать: именно к этой версии откат
kubectl -n agent rollout history deploy/agent | tail -3
kubectl diff -f k8s/agent/00-config.yaml          # ключи, которые применение УДАЛИТ из живого agent-config (kubectl apply сносит то, чего нет в файле)
kubectl diff -f k8s/agent/02-deployment.yaml
```

Если `diff` показывает чужие ключи или образ: **не применять, пока не согласовано с их владельцем** — перенести нужные ключи в манифест
(в PR), иначе выкат молча выключит чужую настройку. Теги образов проверять в реестре перед сборкой: занятый тег нельзя переписывать
(в тот раз `0.5.0` был занят, поэтому у агента тег `0.6.0`).

## Шаг 1. Резервная копия файла диалогов (admin)

Единственный настоящий откат после миграции — копия, снятая до неё. Манифесты — `k8s/agent/backup-job.yaml` и `backup-reader.yaml`.

```bash
# 1. Остановить агента (SIGTERM дописывает всё несохранённое на диск; люди переподключатся после выката)
kubectl -n agent scale deploy/agent --replicas=0
kubectl -n agent wait --for=delete pod -l app=agent --timeout=120s

# 2. Копия и проверка (Job из backup-job.yaml; на образе прежнего агента из реестра, istio-sidecar отключён)
kubectl apply -f k8s/agent/backup-job.yaml
kubectl -n agent wait --for=condition=complete job/agent-db-backup --timeout=180s
kubectl -n agent logs job/agent-db-backup   # ждём: integrity_check: ok, source и copy совпали, user_version: 1
```

Если Job упал или счётчики не совпали — **выкат не начинать**, разобраться.

Вынести копию с кластера (диск без бэкапов, класс `Delete`):

```bash
kubectl -n agent apply -f k8s/agent/backup-reader.yaml   # под agent-db-reader (агент остановлен, том свободен)
kubectl -n agent exec agent-db-reader -- ls -la /data/backups
kubectl -n agent cp agent-db-reader:/data/backups/<файл> ./dialogs-before-agent-0.6.0.sqlite3
kubectl -n agent delete pod agent-db-reader
```

Заодно прогнать миграцию на локальной копии: `DIALOG_DB_PATH=<копия> uv run python -c "from app.services.dialog_db import DialogDatabase; d=DialogDatabase('<копия>'); d.open()"` — строка «dialog db migrated schema v1 -> v2», без ошибок.

## Шаг 2. Раскатка шага 1 (память выключена)

Порядок: ConfigMap → агент → api → web и pwa. После каждого пункта проверка.

```bash
# ConfigMap агента: MEMORY_MODE "off", MEMORY_RECLAIM_SECONDS, GEMINI_TPM_LIMIT/ENFORCE и др. (старый агент лишние ключи игнорирует)
kubectl apply -f k8s/agent/00-config.yaml
# Агент 0.6.0 (replicas: 1 в манифесте, Recreate)
kubectl apply -f k8s/agent/02-deployment.yaml
kubectl -n agent rollout status deploy/agent --timeout=300s
kubectl -n agent logs deploy/agent | grep -E "migrated schema|agent started|dialog db opened|WARNING|ERROR"
```

Ждём в журнале: `dialog db migrated schema v1 -> v2`, `dialog db opened … schema=v2 dialogs=<N>` (**N как в копии**),
`agent started: pipeline=gemini-live … dialogs=sqlite memory=off`, прогрев фраз без ошибок. `/health/ready` — `"dialogs": "sqlite"`.

```bash
# api, затем клиенты (новые клиенты просят Opus; api без этого образа не выберет кодек, и всем уйдёт PCM)
kubectl apply -f k8s/app/00-app-config.yaml -f k8s/app/api/03-deployment.yaml
kubectl -n prod rollout status deploy/app-api --timeout=300s
kubectl apply -f k8s/app/web/03-deployment.yaml -f k8s/app/pwa/03-deployment.yaml
kubectl -n prod rollout status deploy/app-web deploy/app-pwa --timeout=300s
```

### Проверка после шага 2

- Диалоги пережили выкат: гостевой аккаунт открывает «журнал», старые разговоры на месте (число диалогов в журнале агента = N).
- Разговор голосом и текстом работает; в журнале api строка выбранного кодека (`codec: opus` для новых клиентов).
- Метрики агента: `agent_gemini_tpm_window_tokens`, `agent_dialog_users_in_memory`, `process_resident_memory_bytes`;
  в Prometheus не должно быть роста `agent_gemini_quota_errors_total`.
- Экран «Память» у людей **не показан** (агент в режиме `off`).
- Память и CPU подов: `kubectl -n agent top pod`, `kubectl -n prod top pod` (api: лимит памяти 384Mi — если упирается, поднять).

## Шаг 3. Включение памяти (отдельный деплой, после наблюдения)

Предусловия: сутки без ошибок после шага 2; политика конфиденциальности и согласие на память согласованы с владельцем; решения по
памяти из `agent/README.md` («Память», открытые вопросы) приняты.

1. В `k8s/agent/00-config.yaml`: `MEMORY_MODE: "shadow"` (извлечение у включивших память, без сводки в разговоре) для проверки, затем `"on"`.
2. `kubectl apply -f k8s/agent/00-config.yaml && kubectl -n agent rollout restart deploy/agent`.
3. В журнале `agent started: … memory=on` (или `shadow`); у тестового аккаунта включить память, поговорить, через `MEMORY_IDLE_MINUTES`
   (20) убедиться в извлечённых фактах на экране «Память».
4. Откат функции — `MEMORY_MODE: "off"` и перезапуск (данные остаются, чтение и стирание работают).

## Откат

| Что случилось | Что делать |
|---|---|
| Агент не стартует после миграции или ломает данные | `scale --replicas=0`, вернуть копию (ниже), образ, записанный перед выкатом (см. «Сверка с живым кластером»), и прежний `agent-config`; диалоги, созданные после шага 2, теряются |
| Нужен только откат звука | убрать `opus` из `DIALOG_AUDIO_CODECS` в `app-config`, перезапустить `app-api` (клиенты получат μ-law или PCM) |
| Голос Gemini недоступен (квота, оплата) | `VOICE_PIPELINE: "cascade"` в `agent-config`, `rollout restart deploy/agent` |
| Агента убивает по памяти | поднять лимит памяти в `02-deployment.yaml` (сейчас 768Mi), проверить `agent_dialog_users_in_memory` |

Возврат копии файла (агент остановлен):

```bash
kubectl -n agent scale deploy/agent --replicas=0
# Job на прежнем образе агента с /data: удалить dialogs.sqlite3, dialogs.sqlite3-wal, dialogs.sqlite3-shm и скопировать /data/backups/<файл> в /data/dialogs.sqlite3
# (по образцу backup-job.yaml; права на каталог — uid/gid 10001)
kubectl -n agent set image deploy/agent agent=<образ, записанный перед выкатом>   # и вернуть прежний agent-config
```

**Агент прежней версии (схема v1) на файле версии 2 не откроет его и перейдёт на хранение в памяти (с ошибкой в журнале): так откат делать нельзя.**
