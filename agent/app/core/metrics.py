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

# Возврат памяти процесса (app/core/reclaim.py, настройка MEMORY_RECLAIM_SECONDS). Сама память процесса и работа сборщика мусора видны в
# стандартных метриках prometheus_client: process_resident_memory_bytes, python_gc_collections_total,
# python_gc_objects_collected_total. step: gc (полная сборка мусора, останавливает цикл событий целиком) | trim (malloc_trim
# в отдельном потоке, цикл событий не держит).
PROCESS_MEMORY_RECLAIM_RUNS_TOTAL = Counter(
    "agent_process_memory_reclaim_runs_total",
    "Проходы возврата памяти.",
)

PROCESS_MEMORY_RECLAIM_SECONDS = Histogram(
    "agent_process_memory_reclaim_seconds",
    "Сколько занимает шаг возврата памяти: сборка мусора (пауза цикла событий) и malloc_trim (от запуска потока до конца, "
    "вместе с ожиданием процессора: под нагрузкой на 0,5 CPU это дольше самого вызова).",
    ["step"],
    buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)

PROCESS_MEMORY_RECLAIM_COLLECTED_OBJECTS_TOTAL = Counter(
    "agent_process_memory_reclaim_collected_objects_total",
    "Недостижимые объекты (ссылочные циклы), которые нашла сборка мусора при возврате памяти.",
)

PROCESS_MEMORY_RECLAIMED_BYTES_TOTAL = Counter(
    "agent_process_memory_reclaimed_bytes_total",
    "На сколько опустилась резидентная память процесса (RSS) за проходы возврата памяти, сумма. Только Linux.",
)
