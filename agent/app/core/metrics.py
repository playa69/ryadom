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

# Ответ Gemini Live пришёл только текстом (расшифровка есть, звука нет): агент озвучивает его сам, иначе человек читает, а не слышит.
LIVE_VOICELESS_ANSWERS_TOTAL = Counter(
    "agent_live_voiceless_answers_total",
    "Ходы Gemini Live, на которые модель ответила текстом без звука; label `outcome`: voiced (озвучено агентом) | skipped.",
    ["outcome"],
)

# Реплика человека осталась без ответа модели (ни звука, ни текста). Шаблонов нет: агент ждёт, не продолжит ли человек, и
# просит модель ответить в свежей сессии.
LIVE_UNANSWERED_TURNS_TOTAL = Counter(
    "agent_live_unanswered_turns_total",
    "Ходы Gemini Live без ответа модели; label `reason`: silent (модель промолчала) | failed (соединение оборвалось посреди хода) | "
    "interrupted (ответ перебила новая «реплика», а та оказалась шумом).",
    ["reason"],
)
LIVE_RECOVERIES_TOTAL = Counter(
    "agent_live_recoveries_total",
    "Чем кончился ход без ответа; label `outcome`: continued (человек заговорил или написал раньше, чем агент переспросил "
    "модель) | answered (модель ответила со второй попытки) | unanswered (снова молчание) | unavailable (сессию не открыть).",
    ["outcome"],
)

# Ответ модели с буквами чужой письменности посреди русского текста («бывает很 тяжелой»): из текста они убраны, звук уже был.
LIVE_FOREIGN_SCRIPT_TOTAL = Counter(
    "agent_live_foreign_script_total",
    "Куски ответа Gemini Live с буквами чужих письменностей (иероглифы, хангыль, арабское письмо…): убраны из текста и истории.",
)

# Расшифровка реплики оказалась обрывком чужого языка («usted»): ответ модели выброшен, человека просят повторить.
LIVE_REPEAT_REQUESTS_TOTAL = Counter(
    "agent_live_repeat_requests_total",
    "Голосовые реплики, расшифрованные одним-тремя словами без русских букв: ответ модели выброшен, человека попросили повторить.",
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

# Диалоги на диске (DIALOG_DB_PATH). op: open | load | write | erase | delete | mark | clear.
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

# reason: socket — у диалога живой сокет; dirty — есть незаписанное на диск (ждёт записи, запись идёт или не удалась);
# memory_off — у человека жив разговор «Без памяти» (срок его удаления живёт только в памяти).
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

# Обращения к компонентам агента: сколько раз он реально позвал распознавание, проверку безопасности, модель, озвучку.
# Без id: по человеку и диалогу те же вызовы уходят кадром `component` в шлюз и дальше в продуктовую аналитику.
#   component  stt | safety | llm | live | tts | memory
#   outcome    ok | error
#   cached     true: ответ взят из памяти фраз, провайдера не звали
COMPONENT_CALLS_TOTAL = Counter(
    "agent_component_calls_total",
    "Обращения к компонентам агента по названию, исходу и признаку «из памяти».",
    ["component", "outcome", "cached"],
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

# ─── Бюджет входных токенов в минуту (GEMINI_TPM_*, app/services/gemini_budget.py) ───

GEMINI_TPM_WINDOW_TOKENS = Gauge(
    "agent_gemini_tpm_window_tokens",
    "Фактические входные токены Gemini Live за последние 60 секунд (по usage_metadata ходов): то, что считает лимит Google.",
)

GEMINI_TPM_LIMIT_TOKENS = Gauge(
    "agent_gemini_tpm_limit_tokens",
    "Действующий лимит входных токенов в минуту: GEMINI_TPM_LIMIT или ниже, если Google отказал раньше (автокалибровка).",
)

# 0 ok, 1 trim, 2 admit_off, 3 hard, 4 cooldown
GEMINI_BUDGET_LEVEL = Gauge(
    "agent_gemini_budget_level",
    "Уровень нагрузки на Gemini: 0 ok, 1 trim, 2 admit_off, 3 hard, 4 cooldown (пауза после 1011).",
)

# purpose: start | rotate | reconnect | voice | tts; result: ok | failed | quota
GEMINI_OPENS_TOTAL = Counter(
    "agent_gemini_opens_total",
    "Открытия сессий Gemini Live: первая в разговоре, смена после ответа, переоткрытие, смена голоса, озвучка фразы.",
    ["purpose", "result"],
)

# where: open | session | tts
GEMINI_QUOTA_ERRORS_TOTAL = Counter(
    "agent_gemini_quota_errors_total",
    "Отказы Google по квоте (1011 «exceeded your current quota»): при открытии, посреди сессии, при озвучке фразы.",
    ["where"],
)

# pipeline: live | cascade
GEMINI_ADMISSION_TOTAL = Counter(
    "agent_gemini_admission_total",
    "Новые сокеты в режиме gemini_live: начаты в Gemini или, когда бюджет исчерпан (GEMINI_TPM_ENFORCE), в каскаде.",
    ["pipeline"],
)

# reason: hard | cooldown
GEMINI_TURNS_DEGRADED_TOTAL = Counter(
    "agent_gemini_turns_degraded_total",
    "Ходы идущего разговора, отданные шаблону без Gemini: окно у лимита (hard) или пауза после 1011 (cooldown).",
    ["reason"],
)

GEMINI_BUDGET_WAIT_SECONDS = Histogram(
    "agent_gemini_budget_wait_seconds",
    "Сколько ход ждал места в окне токенов (GEMINI_TPM_ENFORCE), прежде чем уйти модели или в шаблон.",
    buckets=(0.0, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0),
)

GEMINI_SESSIONS_OPEN = Gauge(
    "agent_gemini_sessions_open",
    "Открытые сейчас сессии Gemini Live (разговоры и озвучка фраз).",
)

# result: ok | failed | deferred. Смена сессии после ответа (GEMINI_TEXT_CONTEXT): новая сессия с текстовой историей вместо накопленного аудио.
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
