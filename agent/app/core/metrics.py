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

# Диалоги в памяти пода и выгрузка неактивных (DIALOG_IDLE_EVICT_SECONDS, DIALOG_MAX_USERS_IN_MEMORY). Размеры обновляются раз в
# DIALOG_EVICT_INTERVAL_SECONDS, вместе с проходом выгрузки.
DIALOG_USERS_IN_MEMORY = Gauge(
    "agent_dialog_users_in_memory",
    "Люди, чьи диалоги сейчас в памяти пода.",
)

DIALOG_DIALOGS_IN_MEMORY = Gauge(
    "agent_dialog_dialogs_in_memory",
    "Диалоги в памяти пода.",
)

DIALOG_MESSAGES_IN_MEMORY = Gauge(
    "agent_dialog_messages_in_memory",
    "Сообщения диалогов в памяти пода.",
)

DIALOG_EVICTIONS_TOTAL = Counter(
    "agent_dialog_evictions_total",
    "Люди, выгруженные из памяти пода: диалоги остались на диске и загрузятся при следующем обращении.",
)

# reason: socket — у диалога живой сокет; dirty — есть незаписанное на диск (ждёт записи, запись идёт или не удалась).
DIALOG_EVICTIONS_SKIPPED_TOTAL = Counter(
    "agent_dialog_evictions_skipped_total",
    "Проверки выгрузки, после которых человек остался в памяти: срок или потолок вышел, но выгружать нельзя.",
    ["reason"],
)

# kind: first — первая загрузка человека после старта пода; reload — загрузка после выгрузки.
DIALOG_LOADS_TOTAL = Counter(
    "agent_dialog_loads_total",
    "Загрузки диалогов человека с диска.",
    ["kind"],
)

DIALOG_LOAD_SECONDS = Histogram(
    "agent_dialog_load_seconds",
    "Сколько занимает загрузка диалогов человека с диска (чтение в фоновом потоке и сборка в памяти).",
    buckets=(0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)

# Режим gemini_live. Токены берутся из usage_metadata ответа Gemini: на каждый ход приходит размер контекста этого хода
# (prompt, то, что оплачивается заново на каждый ход) и сгенерированное (response). direction: prompt | response | total;
# modality: text | audio | all.
GEMINI_TOKENS_TOTAL = Counter(
    "agent_gemini_tokens_total",
    "Токены Gemini Live по usage_metadata: вход (контекст хода) и выход, по модальностям.",
    ["direction", "modality"],
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
