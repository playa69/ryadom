# Выкат выбора голоса агента (PROTEUS-182, REQ-ACC-07): ранбук

Затрагивает **БД app, api, web, pwa и agent**. Лендинг и админка не меняются. Общие проверки выката и критерии отката —
[`k8s/agent/POSTDEPLOY-0.6.0.md`](../agent/POSTDEPLOY-0.6.0.md), автоматические проверки — [`k8s/postdeploy/`](../postdeploy/README.md).
Пулреквест: https://github.com/playa69/ryadom/pull/60. Всё ниже выполняется только после отдельного одобрения человеком (прод).

## Что внутри

| Что | Образ / ресурс | Эффект |
|---|---|---|
| Миграция `0009_agent_voice_name` (nullable колонка `users.agent_voice_name`) | Job `app-migrate-0006`, `app/migrate:0.9.0` | хранение выбранного голоса |
| `voiceName` в `PATCH`/`GET /api/auth/me`, передача агенту при старте диалога | `app/api:0.9.0` | выбор голоса сохраняется в аккаунте |
| Строка «Голос» в профиле, модалка (web) и страница `/profile/voice/` (PWA), 30 mp3-сэмплов | `app/web:0.8.0`, `app/pwa:0.8.0` | выбор и прослушивание |
| `voiceName` в `POST …/dialogs`, голос Gemini Live | `agent/agent:0.9.0`, `APP_VERSION` в `agent-config` | голос разговора и приветствий |

Версии в манифестах: `k8s/app/db/06-job-migrate-0006.yaml`, `k8s/app/api/03-deployment.yaml` (0.9.0), `k8s/app/web/03-deployment.yaml` и
`k8s/app/pwa/03-deployment.yaml` (0.8.0), `k8s/agent/00-config.yaml` и `02-deployment.yaml` (0.9.0). Тег `latest` не используется.

## Порядок и почему именно он

1. **Миграция** — только добавление колонки, старый api её не замечает.
2. **agent 0.9.0** — понимает `voiceName`; старый api его не шлёт, поэтому агент можно выкатывать раньше api. Обратное тоже безопасно: агент 0.8.x
   игнорирует неизвестное поле `voiceName`.
3. **api 0.9.0** — до web и pwa: новый клиент шлёт `PATCH {voiceName}`, а api 0.8.x такое поле отбросит и ответит «Nothing to update» (422).
4. **web 0.8.0 и pwa 0.8.0** — после api.

## До выката (без прода)

- Образы собраны из одной ревизии `main` (в метке `org.opencontainers.image.revision`; ревизию записать в PR) по разделу «Сборка и push образов»
  в [`k8s/README.md`](../README.md), теги `migrate:0.9.0`, `api:0.9.0`, `web:0.8.0`, `pwa:0.8.0`, `agent:0.9.0`. Проверено локально: образы
  собираются, `migrate` содержит `0009_agent_voice_name.sql`, web и pwa отдают `voice-samples/*.mp3` (30 файлов) по префиксу
  публикации (`/app/…`, `/pwa/…`), агент знает 30 имён голосов.
- Push в реестр (`cr.yandex/crpsqeamqpuvrkm5tpr9`) — после одобрения. Теги `0.9.0` и `0.8.0` в реестре должны быть свободны (проверить: чужой
  образ под тем же тегом уже был, см. историю тега агента `0.6.0`).
- Сверка с кластером (read-only, под admin, после одобрения): `kubectl diff` по манифестам из списка выше. Ожидаем ровно: образы api/web/pwa/agent,
  `APP_VERSION` агента и новый Job. Что-то ещё — остановиться.
- Тихое окно: агент выкатывается стратегией `Recreate`, живые разговоры оборвутся (около минуты), клиенты переподключаются сами.
  Проверка: `kubectl -n agent logs deploy/agent -c agent --since=10m | grep "socket opened"` — свежих разговоров нет.
- Снимок БД перед миграцией не обязателен (колонка добавляется без перезаписи строк), но его стоит иметь по общему порядку: скилл backup.

## Шаги (под admin)

```bash
# 1. Миграция
kubectl apply -f k8s/app/db/06-job-migrate-0006.yaml
kubectl -n prod wait --for=condition=complete job/app-migrate-0006 --timeout=180s
kubectl -n prod logs job/app-migrate-0006

# 2. Агент
kubectl apply -f k8s/agent/00-config.yaml -f k8s/agent/02-deployment.yaml
kubectl -n agent rollout status deploy/agent --timeout=300s

# 3. api, затем web и pwa
kubectl apply -f k8s/app/api/03-deployment.yaml
kubectl -n prod rollout status deploy/app-api --timeout=300s
kubectl apply -f k8s/app/web/03-deployment.yaml -f k8s/app/pwa/03-deployment.yaml
kubectl -n prod rollout status deploy/app-web --timeout=300s
kubectl -n prod rollout status deploy/app-pwa --timeout=300s
```

(Имена деплойментов взяты из манифестов: `app-api`, `app-web`, `app-pwa`, у агента `agent` в ns `agent`.)

## Проверки после выката

- Job `app-migrate-0006` завершён, в журнале нет ошибок; `drizzle.__drizzle_migrations` — 10 записей (0000…0009); у `users` есть `agent_voice_name`.
- Все поды `Ready`, перезапусков 0; `agent`: в журнале `agent started: pipeline=gemini-live…`, прогрев фраз без отказов.
- `GET /api/auth/me` отдаёт `voiceName` (у существующих аккаунтов `Charon` / `Kore` по роду).
- Автоматически на тестовом аккаунте: `POSTDEPLOY_FEATURES=1 pytest k8s/postdeploy/test_features.py -k voice --expect post`
  (`test_voice_choice_is_saved_on_the_account`: выбор, отказ на чужое имя и несовпадающий род, сброс к голосу рода).
- Вручную на веб-версии и PWA: «Профиль → Голос» открывает выбор, ▶ играет сэмпл и не меняет выбор, выбор сохраняется и виден после перезагрузки;
  новый разговор отвечает выбранным голосом (приветствие для выбранного имени может озвучиваться чуть дольше, прогрев только по голосам рода).
- Наблюдение: ошибки открытия сессий Gemini (`agent_gemini_opens_total{outcome="failed"}`) не растут; в журнале агента нет `KeyError` по голосу.

## Откат

- Образы: `kubectl -n prod set image deploy/app-web web=<реестр>/app/web:0.7.1` и так же `deploy/app-pwa pwa=…/pwa:0.7.1`, `deploy/app-api api=…/api:0.8.0`; агент — `agent:0.8.1` и
  `APP_VERSION: "0.8.1"` в `agent-config`. Порядок обратный: web и pwa, потом api, потом агент.
- Миграцию откатывать не нужно: колонка nullable и старому коду не мешает. Если всё же понадобится: `ALTER TABLE users DROP COLUMN agent_voice_name;` и убрать
  запись `0009` из `drizzle.__drizzle_migrations`.
- Выбранные людьми голоса при откате остаются в БД; при возврате на новую версию они применятся снова.

## Известные ограничения

- iOS и Android на устройствах и в Capacitor не проверялись; род голосов взят из описания Google и на слух не проверен.
- Голос из профиля действует только в режиме `gemini_live` (в проде он включён); в каскаде поле игнорируется.
- Агент держит имя голоса только в памяти и получает его при каждом старте диалога.
- Сэмплы не входят в офлайн-кэш PWA и раздаются самими образами web и pwa.
