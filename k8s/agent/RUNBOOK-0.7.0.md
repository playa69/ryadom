# Выкат agent 0.7.0: ранбук

Только агент. api, web, pwa, лендинг и база приложения не меняются. Общие проверки выката и критерии отката — в
[POSTDEPLOY-0.6.0.md](POSTDEPLOY-0.6.0.md), автоматические проверки — в [`k8s/postdeploy/`](../postdeploy/README.md).

## Что внутри

| Что | PR | Эффект |
|---|---|---|
| Подсказка языка расшифровки (`GEMINI_INPUT_LANGUAGES`, по умолчанию `ru-RU`), просьба повторить вместо лекции «только по-русски» на обрывок чужого слова, озвучка ответа, пришедшего текстом без звука, род агента по голосу, чистка чужой письменности | #45 | меньше лекций про язык и ответов без звука |
| Шаблонов вместо ответа нет: модель промолчала — пауза `GEMINI_SILENCE_NUDGE_MS` (2 с) и просьба ответить в свежей сессии; обрыв, зависание, ответ, перебитый шумом, — то же; каскад при отказе модели шлёт `error AGENT_LLM_UNAVAILABLE` | #47 | человек не слышит фраз невпопад |
| Новый промпт: длина по содержанию, зацепка в каждом ответе, на «что делать» — разбор, а не советы, род человека по его словам | #47 | живее и под собеседника (замеры в описании #47 и в `agent/README.md`) |

Образ: `cr.yandex/<реестр>/agent/agent:0.7.0`, собран из `main` на ревизии `193bd7a` (метка `org.opencontainers.image.revision`). Тег
`0.6.1` остаётся в реестре для отката.

## Что нужно знать до выката

- **Новые настройки не нужны:** `GEMINI_SILENCE_NUDGE_MS` и `GEMINI_INPUT_LANGUAGES` берутся по умолчанию из кода. В ConfigMap меняется
  только `APP_VERSION`.
- **Новые метрики:** `agent_live_unanswered_turns_total{reason}`, `agent_live_recoveries_total{outcome}`,
  `agent_live_voiceless_answers_total{outcome}`, `agent_live_repeat_requests_total`, `agent_live_foreign_script_total`; новое значение
  `purpose=recover` у `agent_gemini_opens_total`. Переспрос открывает свежую сессию Gemini: при молчании модели это одно лишнее открытие
  на ход (видно в TPM).
- **Данные и схема не затрагиваются.** Файл диалогов остаётся версии 2, память включена. Откат на `0.6.1` безопасен: схема та же.
- **Простой около минуты:** стратегия `Recreate`, живые разговоры оборвутся, клиенты переподключаются сами. Делать в тихое время.

## Шаги (под admin)

1. Сверка с кластером (read-only): `kubectl diff -f k8s/agent/00-config.yaml -f k8s/agent/02-deployment.yaml`. Ожидаем **ровно два
   изменения**: `APP_VERSION` 0.6.1 → 0.7.0 и образ `agent:0.6.1` → `agent:0.7.0`. Что-то ещё — остановиться и разобраться.
2. Образ в реестре: тег `0.7.0`, digest записан в описании PR.
3. Тихое окно: `kubectl -n agent logs deploy/agent -c agent --since=10m | grep "socket opened"` — нет свежих разговоров.
4. Применить и дождаться:
   ```bash
   kubectl apply -f k8s/agent/00-config.yaml
   kubectl apply -f k8s/agent/02-deployment.yaml
   kubectl -n agent rollout status deploy/agent --timeout=300s
   ```

## Проверки после выката

- Под `Ready 2/2`, перезапусков 0; образ пода — digest из PR.
- Журнал: `dialog db opened … schema=v2` (диалогов и сообщений не меньше, чем до выката), `agent started: pipeline=gemini-live… memory=on`,
  прогрев фраз без отказов, предупреждений и ошибок нет.
- `GET /version` отдаёт `0.7.0`; `/health/ready`: `"dialogs": "sqlite"`, `"memory": "on"`.
- Автоматические проверки на тестовом аккаунте: `EXPECT_MEMORY_MODE=on POSTDEPLOY_BASELINE=<снимок> pytest k8s/postdeploy --expect post`.
- Наблюдение: `agent_live_unanswered_turns_total` и `agent_live_recoveries_total{outcome="answered"}` — сколько ходов модель промолчала и
  сколько из них закрыл переспрос; нет роста ошибок квоты (`1011`).

## Откат

`kubectl -n agent set image deploy/agent agent=<реестр>/agent/agent:0.6.1` и `APP_VERSION: "0.6.1"` в `agent-config` (или `kubectl apply`
манифестов из ревизии до этого PR); данные не затронуты.
