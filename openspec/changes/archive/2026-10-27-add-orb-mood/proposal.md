Архив: реализовано, влито в базу `openspec/specs/` 2026-10-27; выкат в прод — задача PROTEUS-168
Поведение теперь описано в `openspec/specs/orb-mood`. Расхождение с этим файлом решено в пользу кода: настройки `GEMINI_MOOD_CLASSIFIER` нет, модель задана в коде, выключателя функции нет (в проекте нет переключателей функций).

# Proposal: add-orb-mood

## Why

Шарик голосового экрана показывает только «кто говорит» (слушает, думает, говорит), но не откликается на человека. Задача PROTEUS-168: шарик должен меняться вместе с настроением разговора — сонный фиолетовый, злой красный, испуганный зелёный, с плавными переходами. Кризисный протокол при этом остаётся как есть: SOS не часть этой задачи.

## What Changes

- **Агент**: после расшифровки реплики отдельный быстрый запрос к текстовой модели (`gemini-3.5-flash-lite`) определяет тон; агент шлёт клиенту новый кадр `mood { tone, intensity, at }`. Включено по умолчанию, работает только в режиме `gemini_live`.
- **Шлюз** (`services/api`): пропускает кадр `mood`, проверяя значения.
- **Клиенты** (веб, мобильный): цвет настроения поверх цвета состояния шарика, плавный переход 1,8 с, порог 0,4, возврат через 15 с.
- **Спека**: `REQ-VOICE-10` в `docs/spec.md`, capability `orb-mood`.

Не входит: изменения кризисного протокола и слов (SOS остаётся прежним), определение по ходу речи, веса эмоций вместо одной метки.

## Capabilities

### New Capabilities

- `orb-mood`: тон реплики → кадр `mood` → цвет шарика.

### Modified Capabilities

- `client-dialog` (шарик получает цвет настроения) — описано в новой capability, отдельной дельты не нужно.

## Impact

- `agent/app/clients/mood_classifier.py` (новый), `agent/app/api/dialog_live.py`, `agent/app/core/config.py`, `agent/app/core/metrics.py`.
- `app/packages/contracts/src/api/dialogs.ts` (кадр `mood`, только добавление), `app/services/api/src/dialogs/gateway.ts`.
- `app/packages/client-core` (`orb-mood.ts`, `dialog-socket.ts`), `app/packages/ui`, `app/apps/web`, `app/apps/mobile`.
- Лишний запрос к Google на каждую голосовую реплику (токены учитываются в `agent_model_usage_total{task="mood"}`).
