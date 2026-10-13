"""Prometheus-метрики голосового диалога. Только счётчики и время: ни звука, ни текста, ни id в labels."""

from prometheus_client import Counter, Histogram

VOICE_INTERRUPTIONS_TOTAL = Counter(
    "agent_voice_interruptions_total",
    "Перебивания озвучки агента (кадр tts_cancel): голосом или нажатием.",
)

VOICE_FALSE_INTERRUPTIONS_TOTAL = Counter(
    "agent_voice_false_interruptions_total",
    "Перебивания, после которых реплика оказалась пустой: детектор принял эхо или шум за речь.",
)

VOICE_TURN_END_DELAY_SECONDS = Histogram(
    "agent_voice_turn_end_delay_seconds",
    "Время от последнего кадра с речью до audio_end: сколько тишины ждёт детектор конца реплики.",
    buckets=(0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0, 10.0),
)

VOICE_TURNS_TRUNCATED_TOTAL = Counter(
    "agent_voice_turns_truncated_total",
    "Голосовые реплики длиннее VOICE_TURN_MAX_SECONDS: звук сверх предела отброшен.",
)

# Где уходит время от конца реплики человека до первого звука. Этапы (label `stage`, всегда один из этого списка):
#   stt            audio_end → готов текст (только голос)
#   first_sentence начало обработки → первое предложение ответа готово (assistant_start)
#   tts_first      синтез первого куска у провайдера озвучки
#   first_sound    конец реплики человека (или его сообщение) → tts_start: то, что человек ощущает как паузу
VOICE_LATENCY_SECONDS = Histogram(
    "agent_voice_latency_seconds",
    "Задержки голосового ответа по этапам.",
    ["stage"],
    buckets=(0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 10.0, 20.0),
)

VOICE_ECHO_TOTAL = Counter(
    "agent_voice_echo_total",
    "Реплики, начатые поверх озвучки, чей текст — слова самого агента: микрофон поймал динамик, ответа не будет.",
)

VOICE_HELD_TURNS_TOTAL = Counter(
    "agent_voice_held_turns_total",
    "Реплики, оборванные на полуслове (союз, запятая): ответ задержан, пока человек договаривает.",
)

# Диалоги на диске (DIALOG_DB_PATH). op: open | load | write | erase.
DIALOG_DB_ERRORS_TOTAL = Counter(
    "agent_dialog_db_errors_total",
    "Сбои базы диалогов на диске: при сбое запись повторяется, диалоги остаются в памяти.",
    ["op"],
)

DIALOG_DB_WRITE_SECONDS = Histogram(
    "agent_dialog_db_write_seconds",
    "Сколько занимает запись пачки изменённых диалогов на диск (фоновый поток).",
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
)

# Расход моделей (app/services/usage.py): каждый вызов модели, в том числе вне диалогов (прогрев фраз при старте). По
# диалогам то же лежит в таблице model_usage базы диалогов; здесь без id, поэтому стирание человека сумм не трогает.
# Метки, всегда из коротких списков:
#   model      имя модели, как его знает провайдер (gemini-3.8-live, gigachat3.5-432b-a28b, whisper-large-v3, ...)
#   task       live (ход речь в речь) | phrase (озвучка фиксированной фразы) | stt | chat | tts
#   direction  input | output
#   modality   text | audio | thinking | other (часть итога провайдера без разбивки по модальностям)
#   unit       tokens | seconds (аудио) | chars (текст на озвучку)
MODEL_USAGE_TOTAL = Counter(
    "agent_model_usage_total",
    "Расход моделей: токены, секунды аудио или символы, по модели, задаче, направлению и модальности.",
    ["model", "task", "direction", "modality", "unit"],
)

DIALOGS_TOTAL = Counter(
    "agent_dialogs_total",
    "Диалоги, в которых человек сказал или написал хоть что-то (считаются по его первой реплике).",
)

# speaker: human (голосовые реплики человека, от audio_start до audio_end) | agent (озвученные ответы агента, что дошло до клиента).
SPEECH_SECONDS_TOTAL = Counter(
    "agent_speech_seconds_total",
    "Секунды речи в сообщениях диалогов: голос человека и озвучка ответов агента.",
    ["speaker"],
)

# result: ok | failed. Смена сессии после ответа (GEMINI_TEXT_CONTEXT): новая сессия с текстовой историей вместо накопленного аудио.
GEMINI_CONTEXT_REFRESH_TOTAL = Counter(
    "agent_gemini_context_refresh_total",
    "Смены сессии Gemini Live с переносом контекста текстом.",
    ["result"],
)

GEMINI_CONTEXT_REFRESH_SECONDS = Histogram(
    "agent_gemini_context_refresh_seconds",
    "Сколько занимает смена сессии: соединение и загрузка текстовой истории (в фоне, между репликами).",
    buckets=(0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0, 15.0),
)
