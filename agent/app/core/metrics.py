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

# ─── Конвейеры (cascade / gemini_live) и откат ────────────────────────────────
# Метки значений фиксированные (никаких id, текстов и сообщений об ошибках). Старые метрики agent_voice_* не менялись:
# они считают и каскад, и gemini_live, а разрез по конвейеру даёт то, что ниже.

_FIRST_SOUND_BUCKETS = (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 6.0, 10.0)

PIPELINE_REPLIES_TOTAL = Counter(
    "agent_replies_total",
    "Ответы агента по конвейеру и источнику текста. pipeline: cascade | gemini_live; source: gemini | chat | template | crisis.",
    ["pipeline", "source"],
)

PIPELINE_FIRST_SOUND_SECONDS = Histogram(
    "agent_pipeline_first_sound_seconds",
    "Конец реплики человека (или его сообщение) → первый звук ответа, по конвейеру, который ответил.",
    ["pipeline"],
    buckets=_FIRST_SOUND_BUCKETS,
)

PIPELINE_FALLBACK_TOTAL = Counter(
    "agent_pipeline_fallback_total",
    "Реплики, на которые вместо Gemini ответил каскад (или шаблон). reason: breaker_open | connect_failed | send_failed | "
    "link_closed | first_output_timeout.",
    ["reason"],
)

GEMINI_BREAKER_STATE = Gauge(
    "agent_gemini_breaker_state",
    "Размыкатель Gemini Live: 0 — закрыт (Gemini работает), 1 — разомкнут (реплики идут в каскад), 2 — идёт проверка.",
)

GEMINI_BREAKER_TRANSITIONS_TOTAL = Counter(
    "agent_gemini_breaker_transitions_total",
    "Переходы размыкателя Gemini Live по новому состоянию (closed | open | half_open).",
    ["to"],
)

GEMINI_ACTIVE_LINKS = Gauge(
    "agent_gemini_live_active_links",
    "Открытые соединения с Gemini Live (по одному на диалог с сокетом, плюс короткие на озвучку фраз).",
)

GEMINI_CONNECT_SECONDS = Histogram(
    "agent_gemini_live_connect_seconds",
    "Время открытия соединения с Gemini Live (через релей, если он задан).",
    buckets=(0.1, 0.25, 0.5, 0.75, 1.0, 2.0, 4.0, 8.0, 16.0),
)

GEMINI_CONNECT_FAILURES_TOTAL = Counter(
    "agent_gemini_live_connect_failures_total",
    "Отказы открыть соединение с Gemini Live. reason: location | auth | quota | timeout | network | other.",
    ["reason"],
)

GEMINI_EVENTS_TOTAL = Counter(
    "agent_gemini_live_events_total",
    "События соединения с Gemini Live. kind: go_away | closed | interrupted | resumption_handle.",
    ["kind"],
)

GEMINI_RESUME_TOTAL = Counter(
    "agent_gemini_live_resume_total",
    "Повторные открытия соединения с контекстом. result: resumed (по handle) | rejected (handle не принят, контекст текстом) | fresh.",
    ["result"],
)

GEMINI_TOKENS_TOTAL = Counter(
    "agent_gemini_tokens_total",
    "Токены Gemini по usage_metadata (приращения; приблизительно). direction: input | output | total; modality: audio | text | all.",
    ["direction", "modality"],
)

LIVE_STAGE_SECONDS = Histogram(
    "agent_live_stage_seconds",
    "Этапы хода gemini_live от конца реплики: расшифровка (in_first), первый ответ модели (out_first), открытие ворот (gate), "
    "первый звук клиенту (tts_start).",
    ["stage"],
    buckets=_FIRST_SOUND_BUCKETS,
)

LIVE_TURNS_DROPPED_TOTAL = Counter(
    "agent_live_turns_dropped_total",
    "Голосовые реплики gemini_live, на которые нет ответа модели. reason: silence | echo | transcript_missing.",
    ["reason"],
)

LIVE_TRANSCRIPT_RECOVERY_TOTAL = Counter(
    "agent_live_transcript_recovery_total",
    "Расшифровка не пришла от Gemini за GEMINI_TRANSCRIPT_WAIT_MS: запись распознана каскадом. result: recovered | empty | failed | unavailable.",
    ["result"],
)
