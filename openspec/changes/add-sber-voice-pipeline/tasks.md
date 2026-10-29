## 0. Решения

- [x] 0.1 Основной путь — Сбер, запасной — Gemini Live, путь новых разговоров выбирает администратор в админке (владелец,
  PROTEUS-258); 29.10.2026 владелец добавил обратное: запасной путь Gemini Live — Сбер. Приёмка: записано в `proposal.md`.
- [x] 0.2 Селектор голосов в пути Сбера — решение владельца (29.10.2026): профиль показывает голоса действующего пути, выбор голоса
  Gemini сохраняется и возвращается с путём Gemini Live; делается в этом change (`design.md`, «Голос в профиле по пути»). Приёмка:
  записано в PROTEUS-258.
- [ ] 0.3 Мужские голоса SaluteSpeech на 24 кГц — запрос владельцам модельного прокси. Приёмка: ответ в PROTEUS-258.

## 1. Данные и контракты

- [x] 1.1 Таблица выбранного пути и действие журнала: `app/packages/db/src/schema/voice-settings.ts`,
  `app/packages/db/src/schema/types.ts` (`VOICE_PIPELINES`, `VOICE_PIPELINE_CHANGED` в `AUDIT_LOG_ACTIONS`), миграция
  `app/packages/db/migrations/0012_voice_settings.sql`. Приёмка: `pnpm --filter @ryadom/db typecheck`; миграция применяется на базе
  тестов ядра.
- [x] 1.2 Менеджер `app/packages/core/src/managers/voice-settings-manager` (`GetVoicePipelineQuery` — путь и кто когда менял, без
  строки — `sber`; `SetVoicePipelineCommand`) и процесс `app/packages/core/src/processes/voice-settings`
  (`GetVoicePipelineOperation`, `ChangeVoicePipelineOperation`: путь и запись `VOICE_PIPELINE_CHANGED` с `from`/`to` в одной
  транзакции, тот же путь — без записи). Приёмка: `app/packages/core/test/voice-settings.test.ts`.
- [x] 1.3 Старт разговора передаёт путь агенту полем `pipeline`:
  `app/packages/core/src/processes/dialogs/start-dialog/start-dialog.handler.ts`,
  `app/packages/core/src/integrations/agent-api/start-dialog`. Приёмка: `app/packages/core/test/dialogs.test.ts` — тело запроса к
  агенту содержит `pipeline: "sber"` без выбора и `"gemini"` после смены в админке, в том числе при возобновлении.

- [x] 1.4 Путь в профиле: `VOICE_PIPELINES` и голос пути Сбера `SBER_VOICE` («Вера», `Bab-Freespeech`) в
  `app/packages/contracts/src/voices.ts`, поле `voicePipeline` в `MeApiResponse` (`app/packages/contracts/src/api/auth/me.ts`),
  сэмпл `voice-samples/Bab-Freespeech.mp3` в `app/apps/web/public` и `app/apps/mobile/public`. Приёмка:
  `pnpm --filter @ryadom/contracts typecheck`.

## 2. Агент

- [x] 2.1 Путь Сбера `agent/app/clients/sber_voice.py`: потоковый GigaASR с пересчётом 16 → 24 кГц, GigaChat потоком с нарезкой
  на предложения (длинное первое — по запятой), SaluteSpeech на открытой сессии с отменой ответа, напоминание о голосовом формате,
  удаление маркеров списков, женский род агента, учёт расхода. Приёмка: `agent/tests/test_sber_voice.py`.
- [x] 2.2 Запасной путь: `FallbackConnector` (Сбер не открылся → Gemini Live) и `FallbackTts` (SaluteSpeech без звука → Gemini) в
  `agent/app/clients/sber_voice.py`. Приёмка: `agent/tests/test_sber_voice.py`.
- [x] 2.3 Путь по старту разговора: `StartBody.pipeline` (`sber` | `gemini`, иное — 400) в `agent/app/api/dialogs.py`, поле
  разговора в `agent/app/services/dialog_store.py`, сборка путей, путь по умолчанию и прогрев фраз обоих путей в
  `agent/app/main.py`, `voicePipeline` в `agent/app/api/health.py`. Приёмка: `agent/tests/test_voice_pipeline.py` — старт
  запоминает путь и меняет его при возобновлении, путь вне списка — 400; готовность содержит `voicePipeline`.
- [x] 2.4 Окно токенов Gemini только для пути Gemini Live: сессия разговора пути Сбера получает выключенный учёт
  (`agent/app/api/dialogs.py`). Приёмка: `agent/tests/test_voice_pipeline.py` — ход пути Сбера не
  попадает в окно токенов, ход Gemini Live попадает.
- [x] 2.5 Кадры по 40 мс: запас перед речью и длительность реплики считаются в байтах, а не в кадрах
  (`agent/app/api/dialog_session.py`), смоук-скрипты шлют по 40 мс и умеют `--pipeline` (`agent/scripts/live_smoke.py`,
  `agent/scripts/feedback_check.py`). Приёмка: `agent/tests/test_live_scenarios.py`.
- [x] 2.6 Документация: `agent/README.md` (два пути, переменные, замеры пути Сбера), `docs/spec.md` (интерфейс, глоссарий,
  `REQ-GEN-02`), строка про единственный голосовой путь в `.agents/skills/openspec/SKILL.md` (+ `node scripts/sync-agent-skills.mjs`).
  Приёмка: `node scripts/sync-agent-skills.mjs --check`.

- [x] 2.7 Тон реплики в пути Сбера — GigaChat: `GigaChatMoodClassifier` и `SberVoiceConnector.mood_classifier()` в
  `agent/app/clients/sber_voice.py`, классификатор пути в `DialogSession` (`mood`, `agent/app/api/dialog_session.py`), выбор в
  `agent/app/api/dialogs.py` и `agent/app/main.py` (`app.state.moods`); напоминание о формате без фразы про советы. Приёмка:
  `agent/tests/test_sber_voice.py` (разбор ответа, повтор), `agent/tests/test_voice_pipeline.py` (тон пути Сбера без Gemini,
  путь Сбера без своего классификатора не берёт Gemini).

- [x] 2.8 Запасной путь Gemini Live — Сбер: `FallbackConnector(gemini, sber)` и `FallbackTts(gemini, salute)` в
  `agent/app/main.py`, `skip_primary` и `on_primary_error` в `agent/app/clients/sber_voice.py`, `_can_open` и учёт токенов только
  Gemini в `agent/app/api/dialog_session.py`; текст карточки «Gemini Live» в админке. Приёмка: `agent/tests/test_sber_voice.py`
  (соединитель: отказ, пауза), `agent/tests/test_voice_pipeline.py` (Gemini не открылся — ответ Сбера, пауза после квоты — Сбер
  сразу, токены Сбера не в окне Gemini).

## 3. Шлюз API

- [x] 3.1 Лимит звуковых кадров — 50 в секунду с запасом 150 (`app/services/api/src/dialogs/limits.ts`). Приёмка:
  `app/services/api/test/dialogs.test.ts` («поток кадров быстрее, чем говорит человек, — RATE_LIMITED») зелёный с новым лимитом.

- [x] 3.2 `GET` и `PATCH /api/auth/me` отдают `voicePipeline` (`app/services/api/src/routes/auth/me.ts`,
  `app/services/api/src/lib/mappers.ts`); голос Сбера в `voiceName` — 400, как любое имя вне каталога Gemini. Приёмка:
  `app/services/api/test/account.test.ts` («голосовой путь в профиле…»).

## 4. Клиенты

- [x] 4.1 (web, pwa, android, ios, tg) Звук реплики кадрами по 40 мс: `app/packages/client-core/src/voice/capture.ts`,
  `app/apps/web/public/voice-worklet.js`, `app/apps/mobile/public/voice-worklet.js`. Приёмка: `pnpm --filter @ryadom/client-core
  test` (`test/capture.test.ts`: запас перед речью — 15 кадров по 40 мс); e2e из раздела 5.
- [x] 4.2 (admin) Раздел «Голос»: `app/apps/admin/app/(dashboard)/voice/page.tsx`, `voice/actions.ts`,
  `voice/_components/voice-pipeline-form.tsx`, пункт меню в `app/apps/admin/app/(dashboard)/_components/admin-sidebar.tsx`,
  подпись и подробности записи журнала в `app/apps/admin/app/(dashboard)/_lib/labels.ts`. Макет —
  `mockups/admin-voice.html`. Приёмка: `pnpm --filter @ryadom/admin typecheck`; скриншоты из раздела 5.

- [x] 4.3 (web, pwa, android, ios, tg) Голос пути Сбера в профиле: `app/apps/web/components/ProfileVoice.tsx`,
  `app/apps/mobile/src/client/components/pages/profile/VoicePage.tsx`, строка «Голос» в
  `app/apps/mobile/src/client/components/pages/profile/ProfilePage.tsx`, путь в сохранённом пользователе
  (`app/packages/client-core/src/storage.ts`, `app/apps/web/components/ProfileScreen.tsx`). Приёмка: e2e и скриншоты из 5.8.

## 5. Проверка

- [x] 5.1 `dialog-voice`, «Голосовой путь разговора»: «Путь из админки», «Выбора ещё не было», «Смена пути при открытом
  разговоре» — `app/packages/core/test/dialogs.test.ts` и `app/services/api/test/dialogs.test.ts` (тело старта) и
  `agent/tests/test_voice_pipeline.py` (путь разговора); «API без поля пути» — `agent/tests/test_voice_pipeline.py`; «Ответ голосом и текстом», «Ответ на набранное сообщение» в пути Сбера — живой прогон
  `agent/scripts/live_smoke.py --pipeline sber` и `agent/scripts/feedback_check.py --pipeline sber --pace 0.04` (результат — в
  PROTEUS-258).
- [x] 5.2 `dialog-voice`, «Голосовая реплика и расшифровка», «Постоянное слушание»: кадры по 40 мс — e2e
  `app/e2e/tests/web-hands-free.spec.ts` (desktop) и `app/e2e/tests/app-dialog.spec.ts` (mobile); «(Сбер) Распознавание идёт по
  ходу речи» — `agent/tests/test_sber_voice.py` (пересчёт по кадрам) и живой прогон из 5.1.
- [x] 5.3 `dialog-voice`, «Озвучка ответов и фиксированных фраз», «Сбои голосовой модели», «Манера и границы ответов агента»,
  «Выбор голоса агента» — сценарии «(Сбер)» и «(Gemini Live)»: `agent/tests/test_sber_voice.py` (по предложениям, без списков, род,
  запасные пути и запасная озвучка); `agent/tests/test_voice_pipeline.py` (запасной Сбер у Gemini Live, пауза после квоты); голос
  и род — живой прогон из 5.1 (0 мужских форм о себе).
- [x] 5.4 `dialog`, «Коды закрытия, ошибки и лимиты соединения»: `app/services/api/test/dialogs.test.ts` — кадры по 40 мс с
  запасом перед речью проходят, поток быстрее 50 в секунду сверх запаса — `RATE_LIMITED` и 4008.
- [x] 5.5 `admin-console`, «Выбор голосового пути», «Журнал действий», «Каркас админки»: `app/packages/core/test/voice-settings.test.ts`
  (смена с записью, тот же путь без записи, запись без аккаунта не попадает в журнал одного аккаунта); скриншоты 1280 (админка под
  телефон не адаптирована): первое открытие, выбор «Gemini Live», после сохранения, запись в журнале.
- [x] 5.6 `agent-api`, «Служебные эндпоинты»: `agent/tests/test_voice_pipeline.py` — `voicePipeline` в `GET /health/ready`.
- [x] 5.7 Перед сдачей: typecheck и тесты затронутых пакетов app, pytest агента, ruff, `pnpm e2e` (desktop и mobile),
  `node .agents/skills/release-check/scripts/release-check.mjs`.

- [x] 5.8 `dialog-voice`, «Выбор голоса агента», сценарии «(Сбер)»: «Голос в пути Сбера» и «Выбор возвращается с путём Gemini
  Live» — e2e `app/e2e/tests/web-account.spec.ts` (desktop, mobile) и `app/e2e/tests/app-account.spec.ts` (mobile, desktop);
  «Голос Сбера не выбирается» — `app/services/api/test/account.test.ts`; скриншоты шага `voice-sber` на 390 и 1280
  (`pnpm evidence`).

- [x] 5.9 `orb-mood`, «Определение тона реплики», «(Сбер) Тон без Gemini»: `agent/tests/test_voice_pipeline.py`; качество
  классификатора — замер 24 синтетических реплик на прокси (`design.md`, «Тон реплики в пути Сбера определяет GigaChat»).

## 6. Выкат

- [ ] 6.1 Порядок: миграция `0012_voice_settings` → api (лимит кадров, передача пути) → агент → админка → web, PWA и OTA-пакет
  мобильного клиента (кадры 40 мс). Клиент с кадрами по 40 мс раньше api обрывался бы кодом 4008. Приёмка: порядок соблюдён в
  PR выката.
- [ ] 6.2 После выката: `GET /health/ready` агента — `voicePipeline: "sber"`; в журнале агента `socket pipeline … pipeline=sber`;
  смена пути в админке на «Gemini Live» и обратно — в журнале агента следующий старт с новым путём, в журнале действий две записи;
  отказы открытия сессий Сбера (`LiveError` пути Сбера) за первые сутки. Приёмка: результат в PROTEUS-258.

## 7. Архив

- [ ] 7.1 Код в `main` и выкачен; `validate add-sber-voice-pipeline --strict`, `archive add-sber-voice-pipeline --yes`, папка
  `archive/` не в git, `validate --specs --strict`.
