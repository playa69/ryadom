---
name: deploy
description: Выкатить «Рядом» в кластер Timeweb twc-sber500 — собрать образ под linux/amd64 из коммита, отправить в cr.yandex, поднять тег в манифестах k8s/, проверить diff, применить миграции и Deployment, дождаться rollout и проверить, откатить. Использовать при просьбах «задеплой», «выкати агента», «обнови api на проде», «собери образ», «почему под не стартует после выката», «откати», а также при изменении ConfigMap и Secret приложений.
---

# Выкат в кластер

Все сервисы живут в одном кластере Timeweb `twc-sber500`, окружение одно — prod. На машинах людей kubeconfig по
умолчанию может смотреть в другой кластер: задавай его явно. Образы — в `cr.yandex/crpsqeamqpuvrkm5tpr9`, манифесты — в
`k8s/`. Источник правды по шагам — [k8s/README.md](../../../k8s/README.md) («Сервисы из app/», «Сборка и push
образов», «Новая версия»), [k8s/agent/README.md](../../../k8s/agent/README.md) и ранбуки `k8s/agent/RUNBOOK-*.md`.

| Что | Образ | Манифест | ns |
|---|---|---|---|
| api, web, admin, landing, pwa | `…/app/<имя>:<тег>` | `k8s/app/<имя>/03-deployment.yaml` | prod |
| миграции базы `app` | `…/app/migrate:<тег>` | `k8s/app/db/0N-job-migrate-000N.yaml`, Job `app-migrate-000N` | prod |
| агент | `…/agent/agent:<тег>` | `k8s/agent/02-deployment.yaml` + `APP_VERSION` в `k8s/agent/00-config.yaml` | agent |
| cognee | `cognee/cognee:<версия>` (официальный) | `k8s/agent/12-cognee-deployment.yaml` | agent |

Что сейчас в кластере: `kubectl -n prod get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image`
(admin; для `-n agent` хватает developer).

## Правила

- **Выкат — только по прямой просьбе**, и прод — с отдельным «да» человека на этот выкат. Перед ним покажи: ветку и
  SHA, образы и теги, namespace, `kubectl diff`, нужны ли миграции, Secret'ы и admin.
- **admin-kubeconfig** нужен для всего в `prod` и для создания Secret'ов; developer достаточно для ns `agent`.
  admin — только после «да» на конкретные операции.
- **Тег**: не указан — спроси; существующий в реестре не перезаписывать; `latest` не использовать.
- **Изменения в репозитории** — в своей ветке `deploy/<кратко>` в отдельном worktree, коммит
  `deploy(agent): образ 0.8.2 — <что внутри> (#PR)` с ревизией сборки и digest образа в теле, PR в `main`. Мёржит человек.
- **Применять поимённо**, никогда `kubectl apply -f k8s/` или `-R k8s/app`: в каталогах лежат шаблоны Secret'ов с
  `CHANGE_ME` и Job'ы прошлых миграций.

`kubectl` и `docker` ниже — команды к кластеру и к реестру на этой машине (как они подключаются, знает
администратор); скрипт сборки ходит в реестр через `RYADOM_DOCKER` (по умолчанию `docker`, уже вошедший в `cr.yandex`).

## Новая версия

1. **Проверки** в ветке, из которой выкатываешь (скилл `local-dev`): тесты зелёные, коммит запушен.
2. **Сборка** из коммита, а не из рабочего каталога:

   ```bash
   .agents/skills/deploy/scripts/build.sh agent 0.8.2 --ref origin/main          # только собрать
   .agents/skills/deploy/scripts/build.sh agent 0.8.2 --ref origin/main --push   # собрать и отправить
   ```

   Скрипт берёт `git archive` коммита (без `node_modules` и локальных правок, с LF), собирает
   `buildx --platform linux/amd64 --provenance=false --sbom=false --load` с нужными build-arg'ами (`BASE_PATH`,
   `PWA_BASE_PATH`, `RELEASE`, адреса и номер сборки OTA для api), ставит метки ревизии и версии, отказывается от
   занятого тега, проверяет платформу и после push печатает digest. Сборка долгая — запускай в фоне.

   **Ворота совместимости.** Образы api, pwa и web несут клиент или контракт, от которых зависят живые клиенты, поэтому
   собираются только с `--since <коммит прошлого выката>`: скрипт сначала запускает `release-check` (скилл) по
   закоммиченному состоянию от `--since` до `--ref` и не собирает образ при нарушении (код 1) или когда проверить не
   удалось (код 2). Коммит прошлого выката — в теле PR прошлого выката или в метке образа
   `org.opencontainers.image.revision` (читать образ в кластере — после «да»).

   ```bash
   .agents/skills/deploy/scripts/build.sh api 0.8.2 --ref origin/main --since <коммит> --check-only   # только проверка
   .agents/skills/deploy/scripts/build.sh api 0.8.2 --ref origin/main --since <коммит> --push
   ```

   `--no-release-check` пропускает проверку с предупреждением: только по решению человека. Ручная сборка командами из
   `k8s/README.md` ворота обходит — для этих трёх образов её не используй.
3. **Манифест**: тег в `03-deployment.yaml` (у агента — ещё `APP_VERSION` в `00-config.yaml`), для миграции — новый
   файл Job `0N-job-migrate-000N.yaml` по образцу предыдущего с новым образом `migrate`.
4. **Diff**: `kubectl diff -f <файл>` (код 1 = есть различия). Ожидаешь ровно тег образа и версию; что-то ещё (живой
   ConfigMap разошёлся с репозиторием) — остановись и разберись.
5. **Тихое окно для агента**: `kubectl -n agent logs deploy/agent -c agent --since=20m | grep -cE 'socket opened|dialog started'`
   — выкатывай при нуле: стратегия `Recreate`, живые разговоры оборвутся, клиенты переподключатся.
6. **Миграции — первыми**: `kubectl apply -f k8s/app/db/0N-job-migrate-000N.yaml`,
   `kubectl -n prod wait --for=condition=complete job/app-migrate-000N --timeout=240s`, в логах Job — «applied …»;
   затем `kubectl -n prod delete job app-migrate-<предыдущий> --ignore-not-found`.
7. **Сервисы по одному**: `kubectl apply -f k8s/app/<имя>/03-deployment.yaml`,
   `kubectl -n prod rollout status deploy/app-<имя> --timeout=300s`. Порядок для app: migrate → api → web и pwa → landing;
   api должен оставаться совместимым с уже выкаченной PWA.
8. **Проверка**: digest в `kubectl -n prod get pod -l app=app-<имя> -o jsonpath='{.items[0].status.containerStatuses[*].imageID}'`
   (у агента `-n agent -l app=agent`) совпадает с отправленным; журнал старта и ошибки — скилл `logs`; снаружи
   `curl -sI https://xn----htbtgjker8b3a2c.xn--p1ai/api/health`, `/app`, `/pwa/`, `/admin/` (редирект на вход).
9. **Пост-деплойные проверки** на тестовом аккаунте — `k8s/postdeploy` ([README](../../../k8s/postdeploy/README.md)):
   `POSTDEPLOY_BASELINE=<снимок> uv run --no-project --with requests --with websocket-client --with pytest python -m pytest -q -p no:cacheprovider --expect post`
   (снимок с кредами тестового аккаунта хранится у администратора).
10. **PR** с `git diff` манифестов, digest и результатами проверок; для крупного выката — `k8s/agent/RUNBOOK-x.y.z.md`.

## Конфиг и секреты

- **ConfigMap** (`k8s/app/00-app-config.yaml`, `k8s/agent/00-config.yaml`): сначала `kubectl diff`. Если в кластере есть
  значения, которых нет в репозитории, не перезаписывай их целиком — правь только свои ключи
  (`kubectl -n prod patch configmap app-config --type merge --patch-file <файл>`) и верни расхождение в репозиторий
  отдельным PR. Конфиг читается при старте: после правки `kubectl -n <ns> rollout restart deploy/<имя>`.
- **Secret** — только создание: `kubectl -n <ns> create secret generic <имя> --from-env-file=<файл>`, значения даёт
  администратор, в командную строку, вывод и репозиторий они не попадают. Перед созданием — `--dry-run=server -o name`.
  Заменить существующий — только по отдельному «да» с названием Secret'а, namespace и ключей. Какие Secret'ы и ключи
  нужны — таблицы в k8s/README.md и k8s/agent/README.md.

## Обновления мобильного приложения

Четыре рычага и откат (спека `openspec/specs/app-updates`). Нативная ось — ключи `MOBILE_*` в ConfigMap `app-config`
(читаются при старте: после правки `kubectl -n prod rollout restart deploy/app-api`, затем верни значение в
`k8s/app/00-app-config.yaml` тем же PR), ось JS — пакет, запечённый в образ api.

| Что | Как | Что видит человек |
|---|---|---|
| Мягко, JS | обычный выкат api: каждый образ несёт пакет `<версия mobile>.<git rev-list --count>` | ничего: пакет скачивается в фоне и применяется, когда приложение уходит в фон |
| Жёстко, JS | после выката `MOBILE_JS_MIN_VERSION` = версия пакета образа | экран «Обновляемся — это пара секунд» при ближайшей проверке (запуск, возврат в приложение, сеть) |
| Откат JS | вернуть прежний образ api (раздел «Откат») | то же, что жёстко: устройства новее сервера сразу возвращаются на его пакет |
| Мягко, натив | после публикации в магазине `MOBILE_<ANDROID\|IOS>_LATEST_VERSION_CODE` = номер новой сборки | закрываемый баннер «Вышла новая версия» |
| Жёстко, натив | `MOBILE_<ANDROID\|IOS>_MIN_VERSION_CODE` = минимальный рабочий номер | 426 на все запросы и экран «Пора обновить «Рядом»» без закрытия |

- **Версия пакета образа**: `curl -s 'https://xn----htbtgjker8b3a2c.xn--p1ai/api/app-status?platform=android&version_code=1&js_version=0'`
  → `result.jsVersion`. С `js_version`, равной ей, `jsUpdate` должен быть `not_available` — это и есть проверка, что
  пакет сообщает свою версию.
- **Минимум JS опускай** до пустого значения, когда все обновились: иначе после отката образа он потребует версию,
  которой на сервере уже нет (клиентам на ней ничего не будет, отставшие получат пакет сразу).
- **Нативный минимум** поднимай только после того, как сборка доступна в магазинах обеих платформ, а ссылки
  `MOBILE_*_STORE_URL` и `MOBILE_ANDROID_DOWNLOAD_URL` заданы: иначе экран ведёт на страницу `/download`.
- **Нативная релизная сборка** собирает свой JS с `OTA_BUILD_NUMBER=$(git rev-list --count HEAD)` того же коммита,
  что и образ api: тогда свежая сборка из магазина не скачивает пакет, который у неё уже есть. Без номера она
  сообщает `<версия>.0` и сразу получает пакет сервера.

## Откат

- Образ: `kubectl -n <ns> rollout undo deploy/<имя>` или `kubectl -n <ns> set image deploy/<имя> <контейнер>=<прежний образ>`
  (у агента вернуть и `APP_VERSION`), затем `rollout status`.
- ConfigMap — прежняя версия из git, `apply` или `patch`, `rollout restart`.
- Миграции базы назад не откатываются: перед схемой, которую прежний образ не понимает, — бэкап (скилл `backup`) и
  отдельный план в ранбуке.
- Схема очереди задач `pgboss` в базе `app` (ставит образ `migrate`, обновление pg-boss — тоже им) прежнему api не мешает:
  откат api безопасен, поставленные задачи ждут возврата новой версии. Удаление схемы (`DROP SCHEMA pgboss CASCADE`) —
  только по явному «да».

## Грабли

- **`ImagePullBackOff` с `no match for platform`** — образ собран не под `linux/amd64` (например, на Mac без
  `--platform`). Скрипт сборки это проверяет; уже отправленный тег не перезаписывай — следующий тег и откат пода.
- **Push с attestations** падает в этом реестре на «Permission denied» — отсюда `--provenance=false --sbom=false` и
  раздельные `build --load` и `push`.
- **Сборка из `/mnt/c` в WSL** висит на `node_modules` и тащит CRLF — поэтому контекст из `git archive`.
- **Сетевой сбой ≠ «нет ресурса».** Тайм-аут TLS к API кластера или реестру (бывает за VPN) не значит, что секрета или
  образа нет: не создавай ничего «взамен».
- **`kubectl auth can-i`** врёт на сабресурсах (`pods/portforward`, `pods/exec`) — проверяй делом.
- **Публичный репозиторий.** В коммитах, PR, манифестах и ранбуках — без внутренних адресов узлов, названий платёжных
  аккаунтов, значений и способа хранения секретов («хранятся локально у администратора»).

Связано: [[logs]] — проверка после выката; [[backup]] — перед миграцией схемы; [[commit]] — ветка и PR.
