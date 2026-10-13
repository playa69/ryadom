# Проверка выката 0.6.0: что должно быть после каждого шага

Дополнение к [RUNBOOK-0.6.0.md](RUNBOOK-0.6.0.md): ранбук говорит, что выкатывать и в каком порядке, этот документ — как убедиться, что выкат и
миграции прошли успешно, и когда откатывать. Автоматические проверки лежат в [`k8s/postdeploy/`](../postdeploy/README.md).

Все команды `kubectl` ниже — с доступом `admin` (подробнее у администратора), кроме помеченных «read-only»: их хватает доступа разработчика
в ns `agent`. Любой шаг, который что-то меняет в кластере, выполняется отдельным решением владельца.

## 0. Перед выкатом

| Что | Как | Ожидаем |
|---|---|---|
| Тестовый аккаунт и три диалога посеяны | `python k8s/postdeploy/seed.py --out <снимок>` (один раз, до выката) | снимок записан, 3 диалога: два завершённых с итогом и один открытый |
| Сами проверки исправны на текущем проде | `POSTDEPLOY_BASELINE=<снимок> pytest k8s/postdeploy --expect pre` | всё зелёное, пропущены только `post_only` |
| Образы в реестре | `yc container image list --repository-name <реестр>/agent/agent` и так же `app/api`, `app/web`, `app/pwa`, `app/migrate` | теги `0.6.0`, `0.6.1`, `0.6.1`, `0.5.1`, `0.6.1` |
| Что запущено сейчас (read-only) | `kubectl -n agent get deploy agent -o jsonpath='{.spec.template.spec.containers[0].image}'` и то же для `-n prod` (api, web, pwa) | записать: к этим тегам откат |
| Чужие ключи в конфигурации (read-only) | сверка ключей `agent-config` с `00-config.yaml` (см. «Сверка с живым кластером» в ранбуке) | чужих ключей нет; расходится только то, что мы меняем сознательно |
| Агент нагружен? | `kubectl -n agent logs deploy/agent --tail=50` | нет открытых разговоров, которые оборвёт остановка (лучше окно в тихое время) |

## 1. Проверки по шагам

### Шаг 0б — миграция БД приложения

| Проверка | Ожидаем | Если не так |
|---|---|---|
| `kubectl -n prod get job app-migrate-0003` | `Complete 1/1` | `kubectl -n prod logs job/app-migrate-0003`; выкат не продолжать |
| `curl https://<домен>/api/health` | `{"status":"ok"}` (api 0.5.0 ещё работает) | миграция помешала старому api: откат миграции (`DROP TABLE memory_consent_events`, см. шапку Job) |

### Шаг 1 — копия файла диалогов агента

| Проверка | Ожидаем | Если не так |
|---|---|---|
| Журнал Job `agent-db-backup` | `integrity_check: ok`, `source` и `copy` с одинаковыми числами диалогов и сообщений, `user_version: 1` | выкат не начинать |
| Копия вынесена с кластера | локальный файл не пустой; на нём миграция из ранбука печатает `migrated schema v1 -> v2` без ошибок | выкат не начинать |

Числа диалогов и сообщений из журнала Job запомнить: на них сверяется шаг 2.

### Шаг 2а — агент 0.6.0

| Проверка | Ожидаем | Если не так |
|---|---|---|
| `kubectl -n agent rollout status deploy/agent` | `successfully rolled out`; под `1/1 Ready`, перезапусков 0 | `kubectl -n agent describe pod`, журнал; при `CrashLoop` — откат (ниже) |
| Образ пода (read-only) | `…/agent/agent:0.6.0`, digest `sha256:078cc201a3d0a77345523d512fbc54394b259d39962e1235d8a53f81fef3a21f` | на кластере не тот образ — остановиться |
| Журнал: `dialog db migrated schema v1 -> v2` | есть один раз | нет — файл уже v2 или миграция не шла: разобраться, прежде чем двигаться |
| Журнал: `dialog db opened … schema=v2 dialogs=N messages=M` | **N и M как в журнале копии** | меньше — потеря данных: откат |
| Журнал: `agent started: pipeline=gemini-live:… dialogs=sqlite memory=off tracing=langfuse:…` | `dialogs=sqlite`, `memory=off` | `dialogs=memory` — файл не открылся (диалоги пропадут при перезапуске): откат |
| Журнал не содержит `ERROR`, `dialog db is NOT available`, `memory mode=… is NOT available` | чисто | см. сообщение |
| Прогрев фраз | в журнале нет ошибок прогрева (около 28 коротких фраз) | предупреждения Gemini о квоте в первые минуты — смотреть метрики |
| `GET /health/ready` (port-forward, read-only) | `"dialogs": "sqlite"` | `memory` — см. выше |
| `GET /version` | `{"version":"0.6.0"}` (из `APP_VERSION` в ConfigMap) | другая — применён не тот ConfigMap |
| Метрики `/metrics` (port-forward) | `agent_gemini_tpm_limit_tokens 400000`; `agent_dialog_db_errors_total` не растёт; `agent_gemini_budget_level` равен 0 (ok) | рост ошибок записи — смотреть журнал |
| Langfuse (UI) | у свежих трасс тег `v0.6.0`, вход вида `[скрыто: N симв., M сл.]` (текстов нет), трасс `GET /health` нет | видны тексты — в кластере `LANGFUSE_TRACE_TEXT` не `false`: исправить немедленно |

Дополнительно по желанию (admin): схема файла прямо в поде, только чтение:

```bash
kubectl -n agent exec deploy/agent -- python -c "import sqlite3;c=sqlite3.connect('file:/data/dialogs.sqlite3?mode=ro',uri=True);print(c.execute('pragma user_version').fetchone(),c.execute('pragma integrity_check').fetchone(),c.execute('select count(*) from dialogs').fetchone(),c.execute('select count(*) from messages').fetchone(),[r[1] for r in c.execute('pragma table_info(messages)')])"
```

Ожидаем: `(2,) ('ok',)`, числа как в копии, в колонках `messages` есть `audio_seconds`.

### Шаг 2б — api, web, pwa

| Проверка | Ожидаем | Если не так |
|---|---|---|
| `kubectl -n prod rollout status deploy/app-api deploy/app-web deploy/app-pwa` | все `successfully rolled out` | разобрать по журналу; откат нужного сервиса |
| Образы (read-only) | `app/api:0.6.1`, `app/web:0.6.1`, `app/pwa:0.5.1` | не те — остановиться |
| `GET /api/health` | `ok` | см. журнал api (база) |
| Журнал api при разговоре | `Соединение с агентом открыто … codec: opus` для нового клиента и `codec: pcm16` для старого; `Озвучка за соединение` показывает сжатие | только pcm16 у всех — `DIALOG_AUDIO_CODECS` не применён или api старый |
| Заголовок `Content-Security-Policy` у `/app` и `/pwa/` | в `script-src` есть `'wasm-unsafe-eval'` | без него WASM-декодер Opus не стартует (клиенты без WebCodecs останутся без звука) |
| CPU/память (`kubectl top pod -n prod`, `-n agent`) | api не упирается в лимит памяти 384Mi и CPU 1000m, агент в 768Mi | поднять лимиты в манифесте отдельным решением |

### Шаг 2в — автоматические проверки на тестовом аккаунте

```bash
cd k8s/postdeploy
POSTDEPLOY_BASELINE=<снимок> uv run --no-project --with requests --with websocket-client --with pytest python -m pytest -q --expect post
```

Ожидаем: **всё зелёное**. Что именно проверяется — в [README](../postdeploy/README.md). Красное значит:

| Упал тест | Что это значит |
|---|---|
| `test_test_account_is_the_same` | потерян аккаунт в БД приложения |
| `test_dialogs_survived`, `test_messages_survived` | миграция файла диалогов агента потеряла или исказила данные: **откат из копии** |
| `test_open_dialog_resumes` | открытый диалог не вернулся: проверить журнал агента (`dialog db opened`) |
| `test_text_turn_with_voice_for_a_legacy_client` | диалог не работает у старых клиентов: ответа нет, нет озвучки pcm16 или реплика не сохранилась |
| `test_opus_is_negotiated_and_well_formed` | api не выбрал или неверно собрал Opus: проверить `DIALOG_AUDIO_CODECS`, журнал api; временно убрать `opus` из конфигурации |
| `test_csp_lets_the_opus_decoder_run` | не применены web/pwa 0.6.1/0.5.1 или нет `'wasm-unsafe-eval'` |
| `test_memory_is_in_the_expected_mode` | режим памяти не `off` (ожидаем на шаге 2): проверить `agent-config` |

## 2. Ручные проверки (нужны человек и устройства)

Автоматика не слышит звук и не видит экран. После шага 2 один человек проходит:

1. **Web (Chrome, десктоп):** вход, «Начать», голосовая реплика (микрофон), ответ звучит без щелчков и обрывов; журнал диалогов показывает старые разговоры; экран «Память» в профиле **отсутствует**.
2. **Тестовый аккаунт в UI:** в журнале три диалога (два завершённых с итогом, один открытый); завершённый открывается, открытый предлагает продолжить или завершить.
3. **PWA на телефоне:** установка или обновление, голосовой ответ.
4. **Устройства без WebCodecs** (Safari на iOS до 26, Firefox на Android): ответ звучит (WASM-декодер). В режиме «Блокировка» на iOS WebAssembly выключен: должен сработать μ-law, а не тишина.
5. **Старое приложение** (установленное из магазина, без `codecs` в `hello`): диалог работает как раньше (pcm16).
6. **Смена голоса** посреди разговора (переоткрытие сессии Gemini с историей).
7. **Кризисная фраза** в тексте: приходят горячие линии (проверять осторожно, на тестовом аккаунте).

## 3. Наблюдение после выката

Первые 30 минут и затем сутки (Prometheus; метрики агента на `:8001/metrics`):

| Что смотреть | Запрос | Норма |
|---|---|---|
| Ошибки квоты Gemini | `increase(agent_gemini_quota_errors_total[30m])` | 0 при обычной нагрузке |
| Окно токенов | `max_over_time(agent_gemini_tpm_window_tokens[30m])` | ниже 70 % от `agent_gemini_tpm_limit_tokens` (400000) |
| Ошибки записи диалогов | `increase(agent_dialog_db_errors_total[30m])` | 0 |
| Диалоги в памяти процесса | `agent_dialog_users_in_memory` | падает после ухода людей (выгрузка через 30 мин), не растёт без конца |
| Возврат памяти | `rate(agent_process_memory_reclaim_runs_total[5m])` | около `1/30` в секунду |
| Память пода агента | `container_memory_working_set_bytes{namespace="agent"}` | ниже 80 % лимита 768Mi |
| Перезапуски | `kubectl get pod -A \| grep -v Running` и `RESTARTS` | 0 у agent, app-api, app-web, app-pwa |
| Ошибки api | доля 5xx в журнале api (Loki) | как до выката |

## 4. Когда откатывать

Откат — немедленно, если выполнено любое из:

- пропали или изменились данные (`test_dialogs_survived` / `test_messages_survived` красные, `dialogs=N` меньше копии);
- агент не стартует или `dialogs=memory` (диалоги не сохраняются);
- сквозной диалог не работает (нет ответа или озвучки) у старого клиента;
- рост ошибок квоты Gemini или 5xx на порядок против до выката, который не проходит за 10 минут.

Порядок откатов и их ограничения — в таблице «Откат» ранбука. Главное ограничение: **агент прежней версии файл версии 2 не откроет**, поэтому
откат данных — только возврат копии файла, снятой на шаге 1.

## 5. После успешной проверки

- Тестовый аккаунт остаётся в проде для следующих выкатов; не удалять. Его события в аналитике отдельно решить (исключающий список или пометка), см. README проверок.
- Записать в память проекта: теги, digest, время, результат проверок.
- Шаг 3 (включение памяти) — отдельным деплоем; перед ним повторить проверки с `EXPECT_MEMORY_MODE=shadow` или `on`.
