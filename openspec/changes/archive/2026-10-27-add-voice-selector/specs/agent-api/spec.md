# Дельта-спецификация: agent-api

## ADDED Requirements

### Requirement: Голос Gemini из профиля при старте диалога

`POST /v1/users/{userId}/dialogs` SHALL принимать необязательное поле `voiceName` (имя голоса Gemini из списка `agent/app/core/voices.py`) вместе с `voice` (род этого голоса) и возвращать его в ответе. Имя вне списка MUST отвергаться ошибкой запроса (`400`), а не заменяться другим голосом. В режиме `VOICE_PIPELINE=gemini_live` `voiceName` SHALL задавать голос сессии Gemini Live и озвучки фиксированных фраз диалога; запрос с `voice`, но без `voiceName`, возвращает диалог на голос рода. В режиме каскада `voiceName` MUST игнорироваться (ответ — `voiceName: null`). Кадр `set_voice` выбирает голос рода и сбрасывает `voiceName`.

#### Scenario: Имя голоса принято

- **WHEN** запрос содержит `{ "voice": "female", "voiceName": "Aoede" }` в режиме `gemini_live`
- **THEN** ответ содержит `voice: "female"` и `voiceName: "Aoede"`, а сессия Gemini Live открывается с голосом `Aoede`

#### Scenario: Имя вне списка

- **WHEN** запрос содержит `voiceName: "Robot"`
- **THEN** ответ — `400`, диалог не создаётся и не меняется
