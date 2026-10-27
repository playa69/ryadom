# Агент в Kubernetes (ns `agent`)

Манифесты агента из `agent/`: голос ведёт Gemini Live (через релей, `agent/relay/README.md`), диалоги хранятся в PostgreSQL,
память человека — Cognee и заметки в базе агента, фоновая модель прокси программы подводит итоги разговоров и недели и извлекает
заметки. Выкат делает администратор вручную; что именно лежит в кластере сейчас, смотреть по `kubectl -n agent get deploy agent`
(тег образа в `02-deployment.yaml` и `APP_VERSION` в ConfigMap держатся равными).

| Файл | Что делает |
|---|---|
| `00-config.yaml` | ConfigMap `agent-config`: только значения, которые отличаются от умолчаний кода (порт, версия, адрес прокси фоновой модели, адрес Cognee, лимит токенов Gemini в минуту и несколько настроек памяти процесса) |
| `01-service.yaml` | Service `agent:8001` (адрес `http://agent.agent.svc.cluster.local:8001` уже стоит в `app-config` как `AGENT_API_URL`) |
| `02-deployment.yaml` | Deployment: 1 реплика, `Recreate`, non-root, read-only rootfs, пробы `/health`, `/health/ready`; диалоги — в PostgreSQL (Secret `agent-db`), голос — Secret `agent-gemini` |
| `04-servicemonitor.yaml` | ServiceMonitor: Prometheus собирает `/metrics` агента (расход моделей, задержки голоса, база диалогов). Применяет admin |
| `10-cognee-config.yaml` | ConfigMap `cognee-config`: Cognee API (память агента) — БД cognee_db в CNPG, модели LiteLLM-прокси, multi-user access control (Bearer) |
| `11-cognee-pvc.yaml` | PVC `cognee-storage` (10 ГБ, сетевой диск Timeweb): граф Kuzu и сырые документы Cognee. Применять до Deployment'а |
| `12-cognee-deployment.yaml` | Deployment `cognee`: 1 реплика, `Recreate`, официальный образ `cognee/cognee`, проба `/health` |
| `13-cognee-service.yaml` | Service `cognee:8000` (`http://cognee.agent.svc.cluster.local:8000`), только внутри кластера |
| `../namespaces/manifests/08-network-policy-agent-service.yaml` | ingress `prod → agent:8001`, egress `prod → agent`, egress агента и cognee к прокси на `:4000` |

Наружу агент не публикуется (HTTPRoute нет): к нему ходят только `app-api` и `app-admin` по внутреннему токену.

## Секреты

Значения хранятся локально у администратора, в git их нет. Создаются командой `create` (не `apply`, чтобы не
перезаписать существующие), значения не печатать:

| Secret | Namespace | Ключи |
|---|---|---|
| `agent-secrets` | `agent` | `AGENT_INTERNAL_TOKEN`, `AGENT_API_TOKEN` (ключ прокси для фоновой модели), необязательно `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` (ключи проекта в Langfuse: заданы оба — трейсинг включён, нет ни одного — выключен, один — агент не стартует) |
| `agent-gemini` | `agent` | **обязателен**: `GEMINI_API_KEY`, `GEMINI_BASE_URL` (адрес релея), `GEMINI_RELAY_TOKEN`. Без Secret'а или любого из трёх ключей под не запускается (`CreateContainerConfigError`), а без `GEMINI_API_KEY` агент не стартует |
| `agent-db` | `agent` | `DIALOG_DATABASE_URL` — DSN PostgreSQL диалогов (пароль роли `agent` из `agent-db-credentials`, ns ryadom-db); создание — «Хранилище диалогов (PostgreSQL…)» |
| `agent-db-credentials` | `ryadom-db` | `password` роли `agent` |
| `app-secrets` | `prod` | уже есть; ключ `AGENT_INTERNAL_TOKEN` с тем же значением, что у агента |

Два разных секрета, не путать:

- `AGENT_INTERNAL_TOKEN` — общий токен между сервисами, **один и тот же** в `agent-secrets` и `app-secrets` (новый случайный,
  например `openssl rand -hex 32`): им `app-api` и `app-admin` представляются агенту. Внутри самого приложения эта
  переменная исторически называется `AGENT_API_TOKEN`, поэтому в Deployment `app-api` и `app-admin` ключ
  `AGENT_INTERNAL_TOKEN` из `app-secrets` подставляется в переменную `AGENT_API_TOKEN`.
- `AGENT_API_TOKEN` у агента — ключ прокси программы для фоновой модели (итоги разговоров и недели, заметки памяти). Принадлежит
  только агенту, в `app-secrets` его нет. Голос ведёт не он, а Gemini (Secret `agent-gemini`). Нет ключа — итоги не подводятся,
  заметки не извлекаются, итоги недели отвечают `502 DIGEST_UNAVAILABLE`, разговор идёт как обычно. Тот же ключ использует Cognee
  (см. «Память агента: Cognee»).

Голос человека выбирает в профиле, `api` передаёт его агенту при старте разговора; для тех, кто не выбирал, действует
`TTS_DEFAULT_VOICE` (в коде `male`). В ConfigMap голос не задаётся.

**Если `app-secrets` создан по старой схеме** (ключ `AGENT_API_TOKEN` с общим токеном или, хуже, с ключом прокси): добавить ключ
`AGENT_INTERNAL_TOKEN` с общим токеном (`kubectl -n prod patch secret app-secrets -p '{"stringData":{"AGENT_INTERNAL_TOKEN":"<токен>"}}'`),
применить Deployment'ы `k8s/app/api/03-deployment.yaml` и `k8s/app/admin/03-deployment.yaml` (они читают новый ключ) и
дождаться раскатки. Лишний ключ `AGENT_API_TOKEN` из `app-secrets` потом можно убрать.

## Первый выкат (порядок важен)

Нужны Docker, `kubectl`, **админский** kubeconfig (NetworkPolicy вне роли `developer`) и `registry-pusher-key.json`.
Применять поимённо, не `-f k8s/` целиком.

```bash
export KUBECONFIG=~/.kube/ryadom-admin.yaml
kubectl get nodes && kubectl -n agent get pods              # read-only проверка доступа
kubectl -n agent get secret registry-pull                   # есть: он нужен для pull образа

# 1. Образ: платформа linux/amd64, контекст — каталог agent/ (префикс cr.yandex/.../agent/ — как у app/)
REG=cr.yandex/crpsqeamqpuvrkm5tpr9/agent
TAG=<тег из 02-deployment.yaml>                             # тот же тег, что в манифесте и в APP_VERSION
cd agent
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load -t $REG/agent:$TAG .
cat ../registry-pusher-key.json | docker login --username json_key --password-stdin cr.yandex
docker push $REG/agent:$TAG
cd ..

# 2. Секреты агента (значения у администратора) и внутренний токен в app-secrets (см. выше). Без agent-gemini и agent-db под не
#    запустится: agent-gemini обязателен (три ключа, «Gemini Live: релей и Secret»), agent-db — «Хранилище диалогов»
kubectl -n agent create secret generic agent-secrets --from-env-file=<файл: AGENT_INTERNAL_TOKEN, AGENT_API_TOKEN (ключ прокси фоновой модели), при трейсинге LANGFUSE_PUBLIC_KEY и LANGFUSE_SECRET_KEY>

# 3. Сеть: без неё api не достучится до агента, а агент — до прокси фоновой модели (релей Gemini идёт по :443, он в 05-network-policy-agent.yaml)
kubectl apply -f k8s/namespaces/manifests/08-network-policy-agent-service.yaml

# 4. Агент
kubectl apply -f k8s/agent/00-config.yaml -f k8s/agent/01-service.yaml -f k8s/agent/02-deployment.yaml
kubectl -n agent rollout status deploy/agent --timeout=180s
```

## Проверка

```bash
# Изнутри кластера, тем же путём, каким ходит api (проверяет NetworkPolicy и DNS):
kubectl -n prod exec deploy/app-api -- wget -qO- http://agent.agent.svc.cluster.local:8001/health      # {"status":"ok"}

# Сам агент: pipeline — имя соединителя Gemini, tts — озвучка фиксированных фраз, llm — фоновая модель (none, если ключа прокси нет)
kubectl -n agent port-forward svc/agent 18001:8001 &
curl -s http://127.0.0.1:18001/health/ready          # {"status":"ok","pipeline":"gemini-live:gemini-3.8-live","tts":"gemini-live:gemini-3.8-live","llm":"proxy:…","dialogs":"postgres","memory":"on"}

# Весь контракт по REST + WebSocket, с голосом (нужен внутренний токен; wav сохраняется для прослушивания)
AGENT_INTERNAL_TOKEN=<токен> python agent/scripts/smoke.py --url http://127.0.0.1:18001 --voice female --wav reply.wav

# Логи: прогрев озвучки фиксированных фраз на старте и старты диалогов с голосом
kubectl -n agent logs deploy/agent | grep -E "прогрев|dialog started|tts failed|WARNING"        # «прогрев озвучки закончен: озвучено N, не удалось 0»
```

Прогрев идёт сессиями Gemini (не больше трёх одновременно): около 16 фраз для каждого из двух голосов, занимает около
полуминуты. Пока он идёт, приветствие может прочитать приложение своим голосом. «Не удалось» больше нуля — смотреть
`прогрев озвучки не удался` выше в журнале (релей, ключ, `GEMINI_BASE_URL`).

Затем на сайте: `https://слышу-рядом.рф/app/` → начать разговор → ответ должен прийти и **прозвучать** (индикатор шара),
в логах агента — `dialog started … voice=male`. Профиль → «Голос агента» → «Женский» → новый разговор → в логах `voice=female`.
Переключатель голоса в профиле и передача голоса агенту — код `app/` (колонка `users.agent_voice`, миграция `0005_agent_voice`);
миграцию накатывает образ `migrate` из Job `k8s/app/db/05-job-migrate-0005.yaml` вместе со всеми остальными (порядок выката app —
`k8s/README.md`, «Новая версия»), отдельных шагов для голоса не нужно.

## Выкат версии после уборки режимов: что смотреть

Эта версия убирает голосовой каскад и флаги фич: голос ведёт только Gemini Live, а поведение «включено» закреплено в коде.
Теги образов и `APP_VERSION` в манифестах пока прежние (образ 0.8.8), новую версию собирает и выкатывает владелец. При выкате
смотреть именно это:

1. **Заметки памяти начинают извлекаться.** Раньше флаг `MEMORY_NOTES_ENABLED` в проде был `false`; теперь заметки извлекаются
   всегда, у людей с включённой памятью и при заданном ключе прокси (`AGENT_API_TOKEN`, `LLM_BASE_URL`). Расход фоновой модели
   вырастет; следить за `agent_model_usage_total` и за `memory_notes` в базе агента.
2. **Срок хранения начинает работать по-настоящему.** Раньше `DIALOG_RETENTION_DRY_RUN` в проде был `true` (только счёт). Теперь
   проход раз в час помечает удалёнными разговоры старше `DIALOG_RETENTION_DAYS` (90 дней), а помеченное физически убирает очистка
   (`app/services/dialog_purge.py`). Первый проход пометит всё накопленное старше 90 дней: на 27.10.2026 таких разговоров в проде
   нет (агент работает с октября), так что первый проход ничего не удалит.
   **Перед выкатом сделать копию базы `agent`**; значения 0 («не удалять») нет. Метрика `agent_dialogs_retention_would_delete`
   удалена.
3. **Secret `agent-gemini` должен содержать все три ключа** (`GEMINI_API_KEY`, `GEMINI_BASE_URL`, `GEMINI_RELAY_TOKEN`): `optional`
   у них снят, без любого под не запустится. Проверить до `kubectl apply` можно по списку ключей без значений:
   `kubectl -n agent describe secret agent-gemini` (показывает имена ключей и размеры, не значения).
4. **Образ без espeak-ng.** Слой с `espeak-ng` из Dockerfile убран, образ меньше. Озвучка фиксированных фраз идёт через Gemini:
   после выката в `/health/ready` поле `tts` должно быть `gemini-live:…`, а в журнале `прогрев озвучки закончен: озвучено N,
   не удалось 0`.
5. **Трейсинг Langfuse включается самими ключами.** Флага `LANGFUSE_ENABLED` нет: заданы оба ключа
   (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) в `agent-secrets` — трейсинг включён, нет ни одного — выключен, один — агент не
   стартует. До выката убедиться, что оба ключа в `agent-secrets` на месте, иначе трейсинг тихо выключится. Тексты реплик в
   Langfuse не уходят никогда, отдельного приёмника расхода (`LANGFUSE_USAGE_SINK`) нет.
6. **Новая метка `purpose=privacy`** в метрике `agent_gemini_opens_total` и в журнале (`gemini live opened … purpose=privacy`):
   то, что человек убрал из памяти (заметку, всю память, паузу, переключатели «Запоминать чувствительное» и «Опираться на прошлые
   разговоры», удаление разговора), переоткрывает сессию Gemini к следующему ходу, чтобы убранное не оставалось в её контексте.
   Рост таких открытий нормален; они входят в `agent_gemini_tpm_window_tokens` как любые открытия.
7. **ConfigMap стал короче.** В `00-config.yaml` остались только значения, отличающиеся от умолчаний кода. Ключи прежнего
   ConfigMap, которых там уже нет (`VOICE_PIPELINE`, `TTS_MODE`, `QWEN_TTS_*` и другие), агент не читает; после `kubectl apply`
   сверить результат `kubectl -n agent get cm agent-config -o yaml` с манифестом.
8. Выкат обрывает текущие диалоги (одна реплика, `Recreate`): делать в тихое время, клиент переподключится к тому же диалогу.

## Gemini Live: релей и Secret `agent-gemini`

Голос агента ведёт Gemini Live (речь в речь). Другого голосового пути нет: без `GEMINI_API_KEY` агент не стартует. Gemini API из
России недоступен (из кластера проверено: `User location is not supported`), поэтому агент ходит через релей на отдельном сервере
в поддерживаемой стране (`agent/relay/README.md`: устройство, проверки, смена токена). Из кластера релей доступен (проверено
временным подом: DNS `sslip.io` резолвится, `/_relay_health` 200, без токена 403). Egress `:443` в ns `agent` уже разрешён
(`05-network-policy-agent.yaml`), новые сетевые правила не нужны.

Secret `agent-gemini` обязателен. Deployment читает из него три ключа без `optional`: `GEMINI_API_KEY`, `GEMINI_BASE_URL` (адрес
релея, `https://<хост>` без слэша на конце и без пути) и `GEMINI_RELAY_TOKEN`. Значения хранятся локально у администратора, в git их
нет. Создаётся командой `create` (не `apply`), нужен админский kubeconfig, значения не печатать:

```bash
kubectl -n agent create secret generic agent-gemini --from-env-file=<файл: GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_RELAY_TOKEN>
# заменить значения у существующего (в консоль идёт только «configured»), затем перезапустить агента:
kubectl -n agent create secret generic agent-gemini --from-env-file=<файл> --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agent rollout restart deploy/agent && kubectl -n agent rollout status deploy/agent --timeout=180s
```

Проверка (порт-форвард как выше):

```bash
curl -s http://127.0.0.1:18001/health/ready      # "pipeline":"gemini-live:gemini-3.8-live", "tts":"gemini-live:gemini-3.8-live"
python agent/scripts/live_smoke.py --url http://127.0.0.1:18001 --token <токен> --pcm-dir <каталог с PCM-репликами> --wav-dir <куда сохранить звук>
kubectl -n agent logs deploy/agent | grep -E "прогрев|agent started|live timeline|live usage|live context|first sound|WARNING"
```

В журнале агента: `прогрев озвучки закончен: озвучено N, не удалось 0` (около полуминуты; пока идёт прогрев, приветствие может прочитать
приложение своим голосом), строки `live timeline … ms: sent=… in_first=… out_first=… tts_start=…` (этапы хода в мс от конца реплики,
без текстов) и `first sound … ms=` (на стенде 0,9-1,2 с).

**Если релей, ключ или `GEMINI_BASE_URL` не работают,** голоса нет совсем: запасного пути нет. Агент отвечает `error
VOICE_UNAVAILABLE`, а в журнале `gemini live not available`. Порядок: проверки 1 и 2 в `agent/relay/README.md` («Проверка»), затем
ключ Gemini и `GEMINI_BASE_URL` в Secret'е `agent-gemini`, затем сервер релея. Откатывать образ незачем: чинится релей или
Secret (смена токена и пересоздание сервера описаны там же).

Что учесть (подробности: `agent/relay/README.md`, «Ёмкость и лимиты»):

- Постоплата Gemini: контекст сессии оплачивается на каждый ход. Чтобы аудио не копилось в контексте, агент меняет сессию на
  свежую и кладёт в неё прошлые реплики текстом (раз в `GEMINI_ROTATE_EVERY` ходов; на стенде -53% входных токенов за 12 ходов;
  схема и замеры в `agent/README.md`). Поставить бюджет Cloud Billing и ограничить ключ по IP релея.
- Агент в памяти (Recreate): выкат и перезапуск обрывают текущие диалоги. Память пода: `agent/README.md`, «Память процесса».
- Сценарии, на которых сверяется поведение Gemini Live (известные расхождения помечены strict xfail «ИЗВЕСТНО: …»):
  `agent/tests/test_live_scenarios.py`.

## Учёт токенов в минуту (GEMINI_TPM_*)

У проекта Google на Gemini один лимит на всех: 400 000 входных токенов в минуту (Tier 2; запросов в минуту и в сутки, числа сессий лимита нет).
Сверх него Google закрывает соединение кодом 1011 «You exceeded your current quota», и при открытии сессии, и посреди хода. В нагрузочном тесте
(150 диалогов) пик был 449 тыс. при лимите 400 тыс. Агент ведёт окно в 60 секунд и после 1011 держит паузу; новые разговоры не
отсекаются, ходы отказа не получают (устройство и метрики: `agent/README.md`, «Учёт токенов в минуту»).

Настройки (`agent-config`, `00-config.yaml`):

| Ключ | В ConfigMap | Что |
|---|---|---|
| `GEMINI_TPM_LIMIT` | `400000` | лимит проекта; `0` выключает учёт целиком (в коде умолчание `0`) |
| `GEMINI_QUOTA_COOLDOWN_SECONDS` | в коде: `5` | начальная пауза после 1011, в ней новые сессии Gemini не открываются; растёт вдвое до 60 с; `0` выключает |
| `GEMINI_TPM_OPEN_FACTOR` | в коде: `1.0` | оценка открытия = байты UTF-8 промпта и истории / 4 × коэффициент; подбирается по графику AI Studio |

Что смотреть: метрика `agent_gemini_tpm_window_tokens` против графика «Peak input tokens per minute» в AI Studio; если метрика ниже графика,
поднять `GEMINI_TPM_OPEN_FACTOR`. Алерт: `agent_gemini_quota_errors_total` растёт. Изменение: правка `00-config.yaml`, `kubectl apply`, затем
`kubectl -n agent rollout restart deploy/agent`. **Откат:** вернуть значения (при необходимости `GEMINI_TPM_LIMIT: "0"`), применить ConfigMap и
перезапустить агента.

## Хранилище диалогов (PostgreSQL, база `agent` в CNPG ryadom-db)

Диалоги дублируются в PostgreSQL (`DIALOG_DATABASE_URL` из Secret `agent-db`, схему создаёт сам агент при старте —
идемпотентный DDL в `agent/app/services/dialog_db.py`). Проверка: `GET /health/ready` должен вернуть
`"dialogs": "postgres"` (если `"memory"`, БД не открылась, причина в журнале как `dialog db is NOT available`).
Агент использует пул с health-check перед выдачей соединения: разорванное соединение заменяется автоматически,
без перезапуска пода. DSN указывает на `ryadom-db-rw`, поэтому после failover новое соединение открывается к актуальному
primary; отдельный read slave не используется. Бэкапы — общие CNPG (WAL + base backups в Object Storage, `k8s/postgres/`).

Первичная подготовка (один раз, admin-kubeconfig). Роль и база агента созданы один раз, манифест есть в истории git:

```bash
# 1. Пароль роли agent (значение хранится локально у администратора, в git не коммитим)
kubectl -n ryadom-db create secret generic agent-db-credentials --from-literal=password="$(openssl rand -hex 16)"
# 2. DSN для рантайма агента (пароль из шага 1)
kubectl -n agent create secret generic agent-db \
  --from-literal=DIALOG_DATABASE_URL="postgresql://agent:<ПАРОЛЬ>@ryadom-db-rw.ryadom-db.svc.cluster.local:5432/agent"
```

## Удаление старого SQLite (PVC `agent-data`)

Миграции старых диалогов НЕТ (решение владельца 2026-10-24): деплой с нуля. Перед выкатом 0.8.0 —
`kubectl -n agent delete pvc agent-data` (reclaimPolicy `Delete`: диск удаляется вместе с файлом `dialogs.sqlite3`,
это и есть удаление старых диалогов и SQLite-памяти). Манифест `03-pvc.yaml` из репозитория удалён.

## Хранилище диалогов до 0.8.0 (PVC `agent-data`, история)

До 0.8.0 диалоги дублировались в файл `/data/dialogs.sqlite3` на сетевом диске Timeweb (`DIALOG_DB_PATH`,
`03-pvc.yaml`). Заметки ниже относятся к тому режиму и нужны только для отката:

- **Схема файла v2 (память агента).** Образ с памятью при первом старте переводит файл из v1 в v2 одной транзакцией (новые колонки
  диалогов и таблицы `memory_*`), при любом `MEMORY_MODE`. **Откат на образ со схемой v1 после этого не поддерживается**: старый
  агент видит версию 2, отказывается открывать файл (`dialogs: memory` в `/health/ready`) и на стирание людей отвечает `503`.
  Копию файла «про запас» не делать: копия не покрывается стиранием людей.
- Файл небольшой (сообщения весят сотни байт). Посмотреть содержимое: только `kubectl exec` под admin-kubeconfig
  (`sqlite3` в образе нет: `python -c "import sqlite3; …"`); тексты разговоров людей без причины не читать.
- Стирание человека (`DELETE /v1/users/{userId}`) удаляло и строки на диске (`secure_delete`) и усекало журнал WAL. В PostgreSQL
  то же обещание выполняет `erase_user` в `app/services/dialog_db.py` (пометка `deleted_at` в одной транзакции, физически строки убирает очистка раз в 10 минут). Если хранилище задано,
  но не подключилось (`"dialogs": "memory"`), стирание отвечает `503`, а не `204`: приложение повторит его, когда БД вернётся.

## Память агента: Cognee (Deployment `cognee`)

Cognee — граф знаний и векторный поиск для памяти агента (REST `/api/v1`). Живёт в том же ns `agent`, наружу не
публикуется (ни ingress, ни HTTPRoute). Единственный потребитель — под agent по адресу
`http://cognee.agent.svc.cluster.local:8000`. Для ручной отладки:
`kubectl -n agent port-forward svc/cognee 18000:8000`.

**Auth ВКЛЮЧЁН (multi-user access control, `ENABLE_BACKEND_ACCESS_CONTROL=true`).** Это не украшение, а требование
per-user памяти: в режиме `multi_tenant=disabled` `/api/v1/search` НЕ фильтрует по датасетам — recall одного
человека возвращал факты другого (проверено 2026-10-21). Агент логинится сервисным пользователем
`agent-service@cognee.dev` (email/пароль — Secret `cognee-service-account`) и ходит с Bearer JWT
(`POST /api/v1/auth/login`, токен живёт `JWT_LIFETIME_SECONDS`=12 ч). Подпись JWT — Secret `cognee-auth`.
В multi-tenant режиме Cognee заводит ОТДЕЛЬНУЮ БД на тенанта (`CREATE DATABASE "<uuid>"` + `CREATE EXTENSION
vector`), поэтому роль `cognee` — SUPERUSER (компромисс: роль выделенная, только для Cognee; без суперпользователя
per-tenant БД не создаются). Пользователь регистрируется один раз через port-forward (`/api/v1/auth/register`
снаружи недоступен — ingress'а нет).

Устройство (манифесты `10-…`-`13-…` в этом каталоге):

- **Образ** — официальный `cognee/cognee` с Docker Hub (проверенная версия указана в `12-cognee-deployment.yaml`),
  1 реплика, `Recreate` (том RWO). Прогрев 3–5 минут — проба `/health` с запасом.
- **Хранение** — реляционные таблицы и векторы в БД `cognee_db` общего CNPG `ryadom-db` (расширение `vector`),
  граф Kuzu и сырые документы на PVC `cognee-storage` (сетевой диск, НЕ local-path: нодный диск теряется вместе
  с нодой). Удаление PVC стирает граф безвозвратно; PostgreSQL-часть покрыта бэкапами CNPG.
- **LLM и эмбеддинги** — через LiteLLM-прокси программы (`LLM_ENDPOINT`/`EMBEDDING_ENDPOINT` в ConfigMap), ключ
  переиспользуется из `agent-secrets` (`AGENT_API_TOKEN`), своего ключа у Cognee нет. Если модель недоступна,
  Cognee стартует, но cognify падает — смотреть логи и список моделей прокси (`GET $LLM_ENDPOINT/models`).

Создание с нуля (каждый шаг отдельным решением администратора, значения секретов не печатать):

```bash
# 1. Роль и БД в CNPG (идемпотентно в части extension; пароль сразу уходит в Secret).
#    SUPERUSER обязателен: в multi-tenant режиме Cognee создаёт БД и extension vector на тенанта.
DBPASS=$(openssl rand -hex 24)
kubectl -n agent create secret generic cognee-db-credentials --from-literal=DB_PASSWORD="$DBPASS"
kubectl exec -n ryadom-db <primary-pod> -- psql -U postgres -c "CREATE ROLE cognee LOGIN PASSWORD '$DBPASS' SUPERUSER;"
kubectl exec -n ryadom-db <primary-pod> -- psql -U postgres -c "CREATE DATABASE cognee_db OWNER cognee;"
kubectl exec -n ryadom-db <primary-pod> -- psql -U postgres -d cognee_db -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 1.1. Секреты auth: подпись JWT и сервисный пользователь агента
kubectl -n agent create secret generic cognee-auth --from-literal=FASTAPI_USERS_JWT_SECRET="$(openssl rand -hex 32)"
kubectl -n agent create secret generic cognee-service-account \
  --from-literal=COGNEE_SERVICE_EMAIL="agent-service@cognee.dev" \
  --from-literal=COGNEE_SERVICE_PASSWORD="$(openssl rand -hex 16)"

# 2. Сеть: ingress ns agent → CNPG (:5432) в postgres/manifests/03-network-policy.yaml,
#    egress cognee → прокси :4000 в namespaces/manifests/08-network-policy-agent-service.yaml
kubectl apply -f k8s/postgres/manifests/03-network-policy.yaml -f k8s/namespaces/manifests/08-network-policy-agent-service.yaml

# 3. Манифесты и проверка
kubectl apply -f k8s/agent/10-cognee-config.yaml -f k8s/agent/11-cognee-pvc.yaml \
              -f k8s/agent/12-cognee-deployment.yaml -f k8s/agent/13-cognee-service.yaml
kubectl -n agent rollout status deploy/cognee --timeout=10m
kubectl -n agent port-forward svc/cognee 8000:8000 &
curl -s localhost:8000/health      # 200

# 4. Регистрация сервисного пользователя (один раз; пароль из Secret не печатать)
SVC_PASS=$(kubectl -n agent get secret cognee-service-account -o jsonpath='{.data.COGNEE_SERVICE_PASSWORD}' | base64 -d)
curl -X POST localhost:8000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"agent-service@cognee.dev\",\"password\":\"$SVC_PASS\"}"
unset SVC_PASS
```

Откат: `kubectl delete -f` этих четырёх манифестов, затем Secret'ы `cognee-db-credentials`, `cognee-auth`,
`cognee-service-account`, PVC `cognee-storage`
(данные графа стираются) и в CNPG `DROP DATABASE cognee_db; DROP ROLE cognee;` (per-tenant БД вида `"<uuid>"` —
тоже вручную). Правила NetworkPolicy можно оставить.

## Расход моделей: база и Prometheus

Что и как считается, запросы SQL и PromQL — `agent/README.md`, «Расход моделей». В базе расход лежит в таблице `model_usage` того же
файла, в сообщениях — `audio_seconds`. Схема дополняется сама при первом открытии новым агентом (таблица и столбец добавочные, идемпотентные). Версия файла при этом
определяется памятью агента (см. ниже): с версии 2 откат образа на 0.4.0 не поддерживается.

Чтобы расход был и в Prometheus, его нужно собирать. Всё ниже — под admin-kubeconfig (у `developer` нет прав на ServiceMonitor,
NetworkPolicy и ns `monitoring`), каждый шаг отдельным решением администратора:

```bash
kubectl apply -f k8s/namespaces/manifests/05-network-policy-agent.yaml        # ingress monitoring → agent:8001
kubectl apply -f k8s/monitoring/manifests/01-network-policy.yaml              # egress prometheus → agent:8001
kubectl apply -f k8s/agent/04-servicemonitor.yaml
# Срок хранения 14 дней (values-prometheus.yaml): Prometheus перезапустится, метрики на PVC останутся
helm upgrade prometheus prometheus-community/kube-prometheus-stack -n monitoring -f k8s/monitoring/values-prometheus.yaml --version 91.8.2
```

Проверка: в Prometheus UI (port-forward, см. `k8s/README.md`) таргет `serviceMonitor/agent/agent/0` в состоянии UP, запрос
`agent_model_usage_total` отдаёт ряды после первого диалога. Хватает ли диска на 14 дней: `prometheus_tsdb_storage_blocks_bytes`
через пару дней, умноженный на 14/дни, должен быть меньше `retentionSize` (3GB), иначе старые блоки уйдут раньше срока.

## Трейсинг Langfuse

Трейсинг LLM-ходов идёт в self-hosted Langfuse (`http://langfuse-web.infra.svc.cluster.local:3000`, адрес в коде `LANGFUSE_HOST`): трасса
на ход диалога (расшифровка, ответ, токены Gemini, задержки этапов), сессия Langfuse = диалог. Включается ключами проекта в Secret
`agent-secrets` (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`): заданы оба — трейсинг включён, нет ни одного — выключен, один без
второго — агент не стартует. Отдельных флагов нет. **Тексты реплик в Langfuse не уходят никогда**: вместо них число символов и
слов, длительность речи, токены и задержки. Расход ходов лежит в самих трассах; отдельного приёмника расхода в Langfuse нет, расход
моделей по-прежнему считается в базе и в Prometheus (раздел выше). В журнале агента при старте `tracing=` в строке `agent started`.

Сеть — отдельным решением администратора:

```bash
kubectl apply -f k8s/namespaces/manifests/05-network-policy-agent.yaml   # egress agent → infra:3000
kubectl apply -f k8s/namespaces/manifests/02-network-policy-infra.yaml   # ingress infra:3000 от ns agent
```

Ключи в Secret кладёт администратор (в git их нет), затем `kubectl -n agent rollout restart deploy/agent`. **Откат:** убрать оба
ключа из Secret и перезапустить агента.

## Память агента (`MEMORY_*`)

Память — два слоя: заметки о человеке в PostgreSQL агента (`memory_notes`) и поиск по прошлым разговорам в Cognee (Deployment
`cognee`, раздел выше; датасет `ryadom_user_<user_id>` на человека). Агент ходит в Cognee по REST (`COGNEE_BASE_URL:
"http://cognee:8000"` в `agent-config`) с Bearer сервисного пользователя (Secret `cognee-service-account`, ключи подключены в
`02-deployment.yaml`). Заметки извлекает фоновая модель прокси по ходу разговора, поэтому им нужны ключ и адрес прокси
(`AGENT_API_TOKEN`, `LLM_BASE_URL`); граф по прошлым разговорам Cognee строит сам (модели прокси из `10-cognee-config.yaml`). Устройство — `agent/README.md`, раздел «Память». Общего режима
памяти (`MEMORY_MODE`) и флагов функции нет: включена ли память у человека, хранится в базе агента (`memory_settings`), API всегда отвечает
`"mode": "on"` ради старых клиентов, а доступ к памяти есть у всех (списка допущенных нет). Согласия и факты SQLite-памяти образов
< 0.8.0 в Cognee не мигрируют (решение владельца): человек включает память заново в профиле.

| Переменная | В ConfigMap / в коде | Смысл |
|---|---|---|
| `COGNEE_BASE_URL` | `http://cognee:8000` | адрес Cognee API; без него (и без email/пароля сервисного пользователя) поиск по прошлым разговорам недоступен, заметки работают |
| `MEMORY_NOTES_MODEL` | в коде: как `LLM_CHAT_MODEL` | модель извлечения заметок |
| `MEMORY_NOTES_MAX` | в коде: `200` | лимит живых заметок на человека |
| `MEMORY_BRIEF_MAX_TOKENS` | в коде: `1200` | размер блока памяти в промпте, токены |

**Остановка извлечения.** Флага «откат функции» нет: заметки извлекаются всегда, пока у человека включена память и задан ключ
прокси. Остановить извлечение для всех можно, убрав ключ прокси (`AGENT_API_TOKEN`) или `LLM_BASE_URL` и перезапустив агента
(`kubectl -n agent rollout restart deploy/agent`); тогда не подводятся и итоги разговоров и недели. Отдельный человек выключает память
своим переключателем в профиле. Данные при любой остановке остаются: человек может прочитать, скачать и стереть их и при выключенной памяти.

## Ограничения (честно)

- **Диалоги в PostgreSQL, реплика одна.** Диалоги дублируются в базу `agent` в CNPG ryadom-db (раздел «Хранилище
  диалогов») и покрыты общими бэкапами CNPG. Реплика одна, `strategy: Recreate`, поэтому на время выката агент недоступен (около минуты вместе с
  прогревом озвучки); текущие сокеты обрываются, а клиент переподключается к
  тому же диалогу.
- **Прогрев.** Первые полминуты после старта приветствие может прочитать приложение своим голосом: фиксированные фразы
  озвучиваются сессиями Gemini (не больше трёх одновременно), а клиент ждёт приветствие не больше 0,9 с. Ответы приложение само не читает.
- **Gemini и релей — внешняя зависимость без запасного пути.** Если релей, ключ или `GEMINI_BASE_URL` не работают, голоса нет:
  агент отвечает `error VOICE_UNAVAILABLE`, человек видит, что голосовая модель недоступна (раздел «Gemini Live: релей и Secret»).
- **Прокси программы нужен только фоновым задачам.** Если он недоступен, разговор идёт как обычно, а итоги разговоров не
  подводятся, заметки не извлекаются, итоги недели отвечают `502 DIGEST_UNAVAILABLE`. Адрес прокси лежит в `agent-config`, egress на
  `:4000` — в `08-…yaml`.

## Откат

`kubectl delete -f k8s/agent/02-deployment.yaml` возвращает состояние «агента в кластере нет»: `app-api` стартует и
работает (его `/api/health` проверяет только БД), диалоги не открываются. Сетевую политику можно оставить.
