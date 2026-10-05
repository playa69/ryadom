# agent: упрощённая версия

Агент «Слышу Рядом» в самом простом виде. Он нужен, чтобы проверить три вещи до появления настоящей логики:
**API работает, озвучка работает, приложение с ним интегрируется.**

Что в нём есть:

- весь контракт `agent-api` ([openspec/changes/add-agent-service/specs/agent-api](../openspec/changes/add-agent-service/specs/agent-api/spec.md)): REST диалогов и один WebSocket на диалог, текст и голос, внутренний токен, единый формат ошибок;
- шаблонные ответы по кругу, без модели; кризис определяется по списку слов и отвечает фиксированным текстом;
- распознавание-заглушка: голосовая реплика превращается в `[голосовая реплика, N с]`;
- настоящая озвучка ответов и приветствия: SaluteSpeech (когда будет ключ) или espeak-ng;
- диалоги в памяти процесса: после перезапуска пропадают, реплика одна.

Чего нет специально: LLM, LangGraph, БД и память, классификаторы, PII-фильтр, Langfuse, несколько реплик. Всё это
остаётся в плане [add-agent-service](../openspec/changes/add-agent-service/tasks.md) и подключается на место
`services/dialog_store.py` и `services/replies.py`.

## Запуск

```bash
cd agent
uv sync
AGENT_INTERNAL_TOKEN=<токен> uv run uvicorn app.main:app --port 8001
```

Без `AGENT_INTERNAL_TOKEN` сервис не стартует. Остальные настройки — в [.env.example](.env.example).

В контейнере (ставит espeak-ng): `docker build -t ryadom-agent .`

## Проверка

```bash
uv run pytest                                   # 59 тестов: REST, WebSocket, голос, озвучка, провайдеры речи
uv run python scripts/smoke.py --url http://127.0.0.1:8001 --token <токен> --wav reply.wav
```

`smoke.py` ходит по живому серверу так же, как шлюз приложения, проверяет всё по порядку и сохраняет голос ответа
в `reply.wav`, чтобы его можно было послушать. Послушать произвольный текст: `GET /dev/tts?text=Привет`
с заголовком `Authorization: Bearer <токен>` (возвращает WAV; не входит в контракт).

## Озвучка

`TTS_PROVIDER=auto` выбирает провайдера сам: SaluteSpeech, если задан `SALUTE_SPEECH_AUTH_KEY`, иначе espeak-ng,
если он есть в PATH, иначе озвучки нет (приложение читает ответы своим голосом). Выход всегда PCM16, 24 кГц, кадры
по 200 мс, как в контракте. `GET /health/ready` показывает выбранного провайдера.

## Подключение приложения

В env приложения (`services/api` и `apps/admin`):

```
AGENT_API_URL=http://<адрес агента>:8001
AGENT_API_TOKEN=<тот же токен, что AGENT_INTERNAL_TOKEN у агента>
```

Локальную заглушку `dev/agent-mock` это не заменяет и не ломает: она остаётся для разработки без агента.
