## MODIFIED Requirements

### Requirement: Кадры клиента и шлюза
Каждый JSON-кадр SHALL нести поле `v: 1`; неизвестные кадры и поля MUST игнорироваться в обе стороны. Клиент → шлюз: `hello`, `message { clientId, text }`, `end { takeaway?, tensionAfter?, recapSource? }`, `audio_start`, `audio_end`, `tts_cancel { messageId }`, `ping`. Шлюз → клиент: `ready { dialogId, greeting, sinceLastDialogHours }`, `ack { clientId, messageId }`, `transcript { text, final, messageId? }`, `assistant_start`, `assistant_delta`, `assistant_end`, `tts_start { messageId, codec, sampleRate }`, `tts_end { messageId }`, `safety { level, text, hotlines }`, `mood { tone, intensity, at }`, `reply_count { today, first }`, `ended { summary }`, `error { code, message }`, `pong`. Двоичные кадры: байт вида, номер `uint32` (big-endian), затем звук; вид `0x01` — голос человека (PCM16, 16 кГц, моно, по 100 мс), вид `0x02` — озвучка агента (24 кГц, по 200 мс, в кодеке соединения). Шлюз MUST переводить кадры агента, копируя поля по имени и отбрасывая остальное, и MUST NOT хранить и писать в журнал содержимое реплик.

Поверхности: api · agent · web · pwa · android · ios · tg

#### Scenario: Порядок кадров на текстовую реплику
- **WHEN** клиент шлёт `message`
- **THEN** он получает `ack`, затем (при кризисе — `safety`), затем `assistant_start`, `assistant_delta` и `assistant_end`

#### Scenario: Готовность
- **WHEN** агент принял соединение
- **THEN** первым его кадром идёт `ready`, а клиент получает `ready` с `dialogId`
- **AND** `greeting` и `sinceLastDialogHours` в `ready` сейчас пусты (`null`): приветствие и число часов приходят в ответе старта

#### Scenario: Счёт принятой реплики
- **WHEN** шлюз принял реплику человека (набранную, переданную агенту, или произнесённую с непустой итоговой расшифровкой) в сохраняемом разговоре
- **THEN** клиент получает `reply_count` с числом принятых реплик аккаунта за московские сутки (`today`) и признаком первой реплики аккаунта (`first`); текста в кадре нет

#### Scenario: Пинг
- **WHEN** клиент шлёт `ping`
- **THEN** шлюз отвечает `pong`

#### Scenario: Неизвестный кадр
- **WHEN** приходит кадр с неизвестным `type`
- **THEN** он игнорируется, соединение продолжает работать
