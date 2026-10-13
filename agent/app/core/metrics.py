"""Prometheus-метрики голосового диалога. Только счётчики и время: ни звука, ни текста, ни id в labels."""

from prometheus_client import Counter, Gauge, Histogram

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
# label `memory`: on — в разговор подмешана сводка памяти, off — нет (сравнение задержки с памятью и без, MEM-15).
VOICE_LATENCY_SECONDS = Histogram(
    "agent_voice_latency_seconds",
    "Задержки голосового ответа по этапам.",
    ["stage", "memory"],
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

# Диалоги на диске (DIALOG_DB_PATH). op: open | load | write | erase | delete.
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

# ─── Память агента (MEM-15). Только коды и счётчики: ни текстов фактов и реплик, ни id людей в labels (I4). ───

# op: add | update | confirm | supersede | expire | user_delete | forget_all
MEMORY_FACTS_TOTAL = Counter(
    "agent_memory_facts_total",
    "Изменения фактов памяти по операциям.",
    ["op"],
)

MEMORY_EXTRACTION_SECONDS = Histogram(
    "agent_memory_extraction_seconds",
    "Сколько занимает одно задание извлечения памяти (вызов модели и запись).",
    buckets=(1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 45.0, 60.0, 90.0, 120.0),
)

# result: done | skipped | failed; reason — код причины (ok, no_facts, too_short, crisis, model, parse…)
MEMORY_EXTRACTION_TOTAL = Counter(
    "agent_memory_extraction_total",
    "Задания извлечения памяти по итогу.",
    ["result", "reason"],
)

# reason: model | parse | timeout | db
MEMORY_EXTRACTION_FAILURES_TOTAL = Counter(
    "agent_memory_extraction_failures_total",
    "Задания извлечения, окончательно не выполненные после всех попыток.",
    ["reason"],
)

# reason: код класса чёрного списка или проверки (diagnosis, contact_pii, not_grounded, tombstone, full…)
MEMORY_BLOCKED_TOTAL = Counter(
    "agent_memory_blocked_total",
    "Операции памяти, отброшенные серверными проверками.",
    ["reason"],
)

MEMORY_BRIEF_TOKENS = Histogram(
    "agent_memory_brief_tokens",
    "Размер сводки памяти в токенах (оценка по знакам: 2,9 знака на токен).",
    buckets=(50, 100, 200, 300, 400, 500, 600, 700, 800, 1000),
)

# result: hit | miss | empty
MEMORY_BRIEF_CACHE_TOTAL = Counter(
    "agent_memory_brief_cache_total",
    "Чтения сводки из кэша процесса на горячем пути хода.",
    ["result"],
)

# action: enable | disable | add | edit | active | pinned | confirm | delete | forget_all | export
MEMORY_USER_ACTIONS_TOTAL = Counter(
    "agent_memory_user_actions_total",
    "Действия людей с памятью.",
    ["action"],
)

# status: queued | running | done | skipped | failed
MEMORY_JOBS = Gauge(
    "agent_memory_jobs",
    "Задания извлечения памяти в базе по статусам.",
    ["status"],
)
