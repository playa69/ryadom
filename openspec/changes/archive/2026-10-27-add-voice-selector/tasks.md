## 1. Каталог и данные
- [x] 1.1 Каталог голосов `contracts/voices.ts` (id, русское имя, род), список имён у агента
- [x] 1.2 Миграция `0009_agent_voice_name`, поле `users.agent_voice_name`
## 2. Сервер
- [x] 2.1 `UpdateUserVoiceCommand` с `voiceName`, `PATCH`/`GET /api/auth/me`
- [x] 2.2 `voiceName` в старте диалога у агента (шлюз → агент)
- [x] 2.3 Агент: `voiceName` в `POST …/dialogs`, голос сессии Gemini Live и озвучки фраз
## 3. Клиенты
- [x] 3.1 Веб: строка «Голос», модалка с табами, ▶, «Отмена» / «Применить»
- [x] 3.2 PWA: страница `/profile/voice/`, табы, ▶, выбор тапом по строке
- [x] 3.3 Сэмплы голосов (mp3) в `public/voice-samples/`
## 4. Проверка
- [x] 4.1 Тесты: core (`user-voice`, `dialogs`), api (`account`), агент (`test_dialog_store`, `test_rest`, `test_live_context`), e2e профиля
- [ ] 4.2 Проверка на устройствах iOS и Android; проверка рода голосов на слух → снято с change'а при архивации 2026-10-27: ручная проверка, а не поведение; переносится в проверки выката (PROTEUS-182)
