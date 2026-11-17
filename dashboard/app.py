"""Дашборд метрик «Слышу Рядом» для Sber500: шесть чисел по дням за весь конкурс — с 2026-11-05
по текущие московские сутки включительно.

    GET /dashboard      — страница с графиками и таблицей (basic auth)
    GET /dashboard/api  — те же числа JSON-ом (basic auth)
    GET /healthz        — для проб, наружу не маршрутизируется

    python app.py --backfill  — разовый досчёт истории в хранилище снимков (идемпотентно)

Метрики (openspec/changes/update-sber500-dashboard-metrics):
- dau — аккаунты с ≥1 пользовательским сообщением за сутки;
- daily_active_account — внутренняя метрика: аккаунты со строго >10 сообщениями за сутки;
- new_users — первый известный день аккаунта (меньшее из first_reply_at, первого сообщения в базе агента
  и первой live-turn трассы Langfuse);
- total_users — накопленный итог по снимкам, удалённые аккаунты не вычитаются;
- llm_requests — логические вызовы LLM по действиям пользователей (записи GENERATION Langfuse);
- tool_requests — успешные вызовы агента к серверу памяти (записи TOOL Langfuse).
Из всех метрик исключён трафик test/internal (по users.properties->>'traffic_type' в базе app).

Сохранённая история сообщений в базе агента неполна (дни 11–16.11.2026 не записаны, провал замечен и в
другие дни), поэтому «сообщения» для dau/daily_active_account считаются по двум источникам: базе агента и
восстановленным из Langfuse ходам live-диалога (записи GENERATION live_turn_voice/live_turn_text: одна
трасса — одно сообщение, связь traceId→userId трассы). Для пары «день, аккаунт» берётся большее из двух
чисел (max), а не сумма: одни и те же ходы не должны считаться дважды — при полной базе верх даёт она,
при потерянных записях — трейсинг. Это приближение: ход, потерянный обоими источниками по-разному,
недосчитывается; завышения за счёт двойного счёта нет.

Прошедшие сутки закрываются снимком в 00:15 МСК в собственную базу дашборда и дальше не
пересчитываются; пробелы досчитываются catch-up'ом ограниченными окнами. Текущие сутки снимком не
закрываются: страница и JSON считают их предварительно из сырых источников при пересчёте (кэш не
дольше часа) и в daily_metrics не пишут. Сырые источники — базы agent и app (только чтение) и API
Langfuse. Наружу уходят только суммы: ни текстов, ни идентификаторов людей сервис не отдаёт.
"""

import base64
import hmac
import html
import json
import logging
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dashboard")

MSK = timezone(timedelta(hours=3))  # в Москве нет перехода на летнее время с 2014 года
CONTEST_START = date(2026, 11, 5)  # фиксированная левая граница периода — начало конкурса
CACHE_SECONDS = 3600
FAILED_LOGINS_PER_MINUTE = 10
ACTIVE_THRESHOLD = 10  # daily_active_account: «строго больше 10 сообщений за сутки»
CLOSE_HOUR, CLOSE_MINUTE = 0, 15  # закрытие суток по Москве: запас на опоздавший трейсинг
SNAPSHOT_RETRY_SECONDS = 600  # сбой снимка — новая попытка через 10 минут, не через сутки
SNAPSHOT_WINDOW_DAYS = 7  # окно выгрузки источников при catch-up/backfill: вся история одним запросом в память не собирается
LANGFUSE_PAGE_LIMIT = 100
# Трассы выгружаются с запасом назад: observation на границе окна может принадлежать трассе, начавшейся
# раньше окна; без запаса она потеряла бы userId и выпала из метрик. Дублей нет: считаются только
# observations своего окна, трассы — справочник traceId → userId.
TRACE_LOOKBACK = timedelta(hours=24)

# Имена GENERATION-записей Langfuse, которые считаются пользовательскими вызовами LLM. Источник — точки
# `Tracer.start_turn` в агенте (agent/app/core/tracing.py): ответы в диалоге (dialog_session.py), оценка
# настроения (sber_voice.py, mood_classifier.py), итог разговора (services/recaps.py), извлечение памяти
# (memory/extractor.py). Не считаются: text_turn (кризисный фиксированный текст, вызова модели нет),
# live_turn_recovery (технический ретрай уже посчитанного хода), gemini_tts_phrase (озвучка), weekly_digest
# (плановая сводка). Новое имя GENERATION в агенте в метрику не попадёт, пока его не добавят сюда осознанно
# (см. README, «Перечни имён»).
LLM_NAMES = frozenset({
    "live_turn_voice",
    "live_turn_text",
    "mood_classify_sber",
    "mood_classify_gemini",
    "dialog_recap",
    "memory_extract",
    "memory_instruct",
})

# Имена GENERATION-записей Langfuse, которые считаются приходом пользовательского сообщения: один ход
# live-диалога (одна трасса) — одно сообщение. Подмножество LLM_NAMES: по ним восстанавливаются сообщения,
# потерянные базой агента (см. шапку файла). live_turn_recovery сюда не входит — это технический ретрай уже
# посчитанного хода, а не новое сообщение; recap/mood/memory — вызванные разговором вызовы, не сообщения.
MESSAGE_TURN_NAMES = frozenset({"live_turn_voice", "live_turn_text"})

# Имена TOOL-записей Langfuse — логические вызовы агента к серверу памяти (Cognee). Источник —
# `Tracer.start_tool` и точки CogneeClient (agent/app/clients/cognee.py): recall/recall_chunks/read_consent →
# memory_search, add_document/remember (add+cognify — один вызов) → memory_write, delete_document →
# memory_delete_document, forget_dataset → memory_forget_dataset. Логин, чтение списка датасетов и
# 401-ретрай внутри `_send` записей не создают.
TOOL_NAMES = frozenset({"memory_search", "memory_write", "memory_delete_document", "memory_forget_dataset"})

METRIC_FIELDS = ("dau", "daily_active_account", "new_users", "llm_requests", "tool_requests")
ZERO_METRICS = dict.fromkeys(METRIC_FIELDS, 0)


def definitions() -> dict[str, str]:
    """Определения метрик для страницы; у llm/tool названы дни начала точного учёта."""
    llm_since = os.environ.get("LLM_REQUESTS_SINCE", "").strip()
    tool_since = os.environ.get("TOOL_REQUESTS_SINCE", "").strip()
    llm_note = (
        f" Точный учёт — начиная с {llm_since} (глубина истории Langfuse), более ранние дни показывают 0."
        if llm_since
        else " Глубина истории ограничена хранилищем Langfuse: дни, для которых записей уже нет, показывают 0."
    )
    tool_note = (
        f" Учёт — начиная с {tool_since} (день включения TOOL-записей агентом), более ранние дни показывают 0."
        if tool_since
        else " Записи появляются со дня включения TOOL-инструментации агента, более ранние дни показывают 0."
    )
    return {
        "dau": "DAU: уникальные аккаунты с хотя бы одним сообщением агенту за сутки. Сообщения считаются по базе "
        "агента и по трейсингу Langfuse вместе (часть истории в базе не сохранилась): для пары «день, аккаунт» "
        "берётся большее из двух чисел, одни и те же ходы дважды не считаются.",
        "daily_active_account": "Активные аккаунты (внутренняя метрика): строго больше 10 сообщений за сутки "
        "(объединённые источники, как у DAU).",
        "new_users": "Новые пользователи: аккаунты, чьё первое известное сообщение пришлось на эти сутки. Первый "
        "известный день — минимум из отметки первого сообщения, первого сохранённого сообщения в базе агента и "
        "первой трассы диалога в Langfuse; каждый аккаунт считается новым ровно один день.",
        "total_users": "Пользователи всего: накопленный итог новых по снимкам; удалённые аккаунты не вычитаются.",
        "llm_requests": "Вызовы LLM: логические вызовы моделей, инициированные действиями пользователей (ответы в диалоге, "
        "итоги разговоров, извлечение памяти, оценка настроения); технические ретраи считаются одним вызовом; прогревы, "
        "кризисный текст, озвучка и плановые сводки не считаются." + llm_note,
        "tool_requests": "Tool calls — Память: успешно выполненные операции агента с сервером памяти (поиск, запись, удаление); "
        "ошибки и служебные обращения не считаются." + tool_note,
    }


# ---------- период ----------

def period_days(now: datetime) -> list[date]:
    """Весь конкурс по московским суткам: с CONTEST_START по текущий день включительно.

    Текущие сутки входят в период всегда, в том числе до закрытия 00:15 МСК: их строка в отчёте
    предварительная и считается из сырых источников при отдаче, снимком не закрывается."""
    today = now.astimezone(MSK).date()
    if today < CONTEST_START:
        return [today]
    return [CONTEST_START + timedelta(days=i) for i in range((today - CONTEST_START).days + 1)]


def utc_bounds(days: list[date]) -> tuple[datetime, datetime]:
    """Начало первых суток и конец последних (не входит) в UTC."""
    start = datetime(days[0].year, days[0].month, days[0].day, tzinfo=MSK)
    end = datetime(days[-1].year, days[-1].month, days[-1].day, tzinfo=MSK) + timedelta(days=1)
    return start.astimezone(UTC), end.astimezone(UTC)


def msk_day(value: str) -> str | None:
    """Метка времени Langfuse (UTC) → московская дата YYYY-MM-DD."""
    text = str(value).strip().replace(" ", "T")
    if not text:
        return None
    if not text.endswith("Z") and "+" not in text[10:] and "-" not in text[10:]:
        text += "Z"
    try:
        at = datetime.fromisoformat(text)
    except ValueError:
        return None
    return at.astimezone(MSK).date().isoformat()


# ---------- чистые функции метрик ----------

def activity_by_day(message_rows: Iterable[tuple[str, str, int]], excluded: set[str]) -> tuple[dict[str, int], dict[str, int]]:
    """Разбивка «день × user_id → число сообщений» → (dau, daily_active_account) по московским суткам.

    Строки уже уникальны по (день, аккаунт), поэтому dau — это число строк дня. Аккаунты из `excluded`
    (test/internal) не считаются; user_id, которого нет в базе app, считается real (такие строки появляются
    после обезличивания)."""
    dau: dict[str, int] = {}
    active: dict[str, int] = {}
    for day, user_id, n in message_rows:
        if str(user_id) in excluded:
            continue
        dau[day] = dau.get(day, 0) + 1
        if n > ACTIVE_THRESHOLD:
            active[day] = active.get(day, 0) + 1
    return dau, active


def first_known_day(first_reply: Mapping[str, str | None], first_message: Mapping[str, str],
                    first_turn: Mapping[str, str] | None = None) -> dict[str, str]:
    """Первый известный день аккаунта: минимум из first_reply_at, первого сохранённого сообщения
    и первой live-turn трассы Langfuse.

    У legacy-аккаунтов first_reply_at остаётся NULL навсегда (миграция 0014), а база агента потеряла часть
    истории (дни 11–16.11.2026), поэтому одним источником обойтись нельзя. Результат по определению
    дедуплицирован: у аккаунта ровно один первый день."""
    out = {str(user): day for user, day in first_message.items()}
    for source in (first_reply, first_turn or {}):
        for user, day in source.items():
            if not day:
                continue
            user = str(user)
            if user not in out or day < out[user]:
                out[user] = day
    return out


def new_users_by_day(first_days: Mapping[str, str], excluded: set[str]) -> dict[str, int]:
    """Число новых аккаунтов по московским суткам, без test/internal."""
    out: dict[str, int] = {}
    for user, day in first_days.items():
        if str(user) in excluded:
            continue
        out[day] = out.get(day, 0) + 1
    return out


def _trace_users(traces: Iterable[dict]) -> dict[str, str]:
    """traceId → userId трассы; трассы без userId (прогревы, системные задачи) не попадают в словарь."""
    out = {}
    for trace in traces:
        user_id = trace.get("userId") or ""
        if trace.get("id") and user_id:
            out[str(trace["id"])] = str(user_id)
    return out


def langfuse_message_rows(generations: Iterable[dict], traces: Iterable[dict],
                          excluded: set[str]) -> list[tuple[str, str, int]]:
    """Восстановленные из Langfuse сообщения: (московский день, user_id, число уникальных traceId).

    Приближение к пользовательским сообщениям базы агента: трасса с записью live_turn_voice/live_turn_text —
    одно сообщение. Дедупликация по (день, user_id, traceId): повторная GENERATION той же трассы (ретрай
    клиента) сообщение не дублирует. Трассы без userId и аккаунты test/internal не считаются, как везде."""
    users = _trace_users(traces)
    turns: set[tuple[str, str, str]] = set()
    for obs in generations:
        if obs.get("name") not in MESSAGE_TURN_NAMES:
            continue
        user_id = users.get(str(obs.get("traceId") or ""))
        if not user_id or user_id in excluded:
            continue
        day = msk_day(obs.get("startTime") or "")
        if day:
            turns.add((day, user_id, str(obs["traceId"])))
    counts: dict[tuple[str, str], int] = {}
    for day, user_id, _trace_id in turns:
        counts[(day, user_id)] = counts.get((day, user_id), 0) + 1
    return [(day, user_id, n) for (day, user_id), n in counts.items()]


def merge_message_rows(message_rows: Iterable[tuple[str, str, int]],
                       langfuse_rows: Iterable[tuple[str, str, int]]) -> list[tuple[str, str, int]]:
    """Объединение разбивок «день × user → число сообщений» из базы агента и Langfuse: max, а не сумма.

    Оба источника описывают одни и те же ходы: у сохранённого сообщения есть и трасса. Сумма посчитала бы
    их дважды; max берёт более полный источник для пары (день, аккаунт) — при полной базе её count, при
    потерянных записях — восстановленное из трейсинга число."""
    merged: dict[tuple[str, str], int] = {}
    for rows in (message_rows, langfuse_rows):
        for day, user_id, n in rows:
            key = (day, str(user_id))
            merged[key] = max(merged.get(key, 0), int(n))
    return [(day, user_id, n) for (day, user_id), n in merged.items()]


def first_langfuse_day(generations: Iterable[dict], traces: Iterable[dict]) -> dict[str, str]:
    """userId → первый московский день с live-turn записью (в пределах переданной выгрузки)."""
    users = _trace_users(traces)
    out: dict[str, str] = {}
    for obs in generations:
        if obs.get("name") not in MESSAGE_TURN_NAMES:
            continue
        user_id = users.get(str(obs.get("traceId") or ""))
        day = msk_day(obs.get("startTime") or "")
        if user_id and day and (user_id not in out or day < out[user_id]):
            out[user_id] = day
    return out


def _fold_first_turns(acc: dict[str, str], raw: Mapping) -> None:
    """Накопить первые live-turn дни аккаунтов через границу окон: min по уже обработанным окнам.

    Выгрузка Langfuse ограничена окном, поэтому без накопления аккаунт, чей первый ход попал в более раннее
    окно, а из баз агент приложения его не знает, посчитался бы новым повторно в более позднем окне."""
    for user, day in first_langfuse_day(raw["generations"], raw["traces"]).items():
        if user not in acc or day < acc[user]:
            acc[user] = day


def _count_observations(
    observations: Iterable[dict], traces: Iterable[dict], names: frozenset, excluded: set[str], *, only_success: bool
) -> dict[str, int]:
    """Записи Langfuse → число по московским суткам: имя из списка, у трассы есть userId, он не test/internal."""
    users = _trace_users(traces)
    out: dict[str, int] = {}
    for obs in observations:
        if obs.get("name") not in names:
            continue
        user_id = users.get(str(obs.get("traceId") or ""))
        if not user_id or user_id in excluded:
            continue
        if only_success and str(obs.get("level") or "").upper() == "ERROR":
            continue
        day = msk_day(obs.get("startTime") or "")
        if day:
            out[day] = out.get(day, 0) + 1
    return out


def llm_requests_by_day(generations: Iterable[dict], traces: Iterable[dict], excluded: set[str]) -> dict[str, int]:
    """Вызовы LLM по суткам. Упавший окончательно вызов всё равно посчитан: обращение к API состоялось."""
    return _count_observations(generations, traces, LLM_NAMES, excluded, only_success=False)


def tool_requests_by_day(tools: Iterable[dict], traces: Iterable[dict], excluded: set[str]) -> dict[str, int]:
    """Вызовы памяти по суткам: только успешные (запись с level=ERROR не считается)."""
    return _count_observations(tools, traces, TOOL_NAMES, excluded, only_success=True)


def metrics_by_day(
    message_rows: Iterable[tuple[str, str, int]],
    first_message: Mapping[str, str],
    excluded: set[str],
    first_reply: Mapping[str, str | None],
    generations: Iterable[dict],
    tools: Iterable[dict],
    traces: Iterable[dict],
    first_turn: Mapping[str, str] | None = None,
) -> dict[str, dict]:
    """Все метрики суток из сырых выгрузок: {день: {dau, daily_active_account, new_users, llm_requests, tool_requests}}.

    «Сообщения» для dau/daily_active_account — объединение базы агента и восстановленных из Langfuse ходов
    (max по паре «день, аккаунт», без двойного счёта). `first_turn` — первые live-turn дни аккаунтов; когда
    не передан, считается по выгрузке этого окна (backfill/catch-up передают накопленное через окна).
    `total_users` здесь нет: он накопительный по снимкам и вычисляется при записи (save_snapshots)."""
    generations, tools, traces = list(generations), list(tools), list(traces)
    dau, active = activity_by_day(merge_message_rows(message_rows, langfuse_message_rows(generations, traces, excluded)), excluded)
    if first_turn is None:
        first_turn = first_langfuse_day(generations, traces)
    new = new_users_by_day(first_known_day(first_reply, first_message, first_turn), excluded)
    llm = llm_requests_by_day(generations, traces, excluded)
    tool = tool_requests_by_day(tools, traces, excluded)
    days = set(dau) | set(active) | set(new) | set(llm) | set(tool)
    return {
        day: {
            "dau": dau.get(day, 0),
            "daily_active_account": active.get(day, 0),
            "new_users": new.get(day, 0),
            "llm_requests": llm.get(day, 0),
            "tool_requests": tool.get(day, 0),
        }
        for day in days
    }


# ---------- источники: базы agent и app (только чтение) ----------

# Помянтная разбивка «день × user_id → число пользовательских сообщений» за период (день по Москве).
SQL_MESSAGES_BY_DAY = """
SELECT to_char((m.created_at::timestamptz AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS day,
  d.user_id, count(*) AS n
FROM messages m JOIN dialogs d ON d.id = m.dialog_id
WHERE m.role = 'user' AND m.created_at::timestamptz >= %(since)s AND m.created_at::timestamptz < %(until)s
GROUP BY 1, 2
"""

# Первый сохранённый день аккаунта за всю историю: покрывает legacy-аккаунтов с NULL first_reply_at.
SQL_FIRST_MESSAGE_DAY = """
SELECT d.user_id, to_char((min(m.created_at::timestamptz) AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS day
FROM messages m JOIN dialogs d ON d.id = m.dialog_id
WHERE m.role = 'user'
GROUP BY 1
"""

# Первый день с сообщениями вообще — левая граница backfill.
SQL_FIRST_DAY_EVER = """
SELECT to_char((min(m.created_at::timestamptz) AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD')
FROM messages m WHERE m.role = 'user'
"""

# База app: аккаунты с нереальным трафиком (команда, боты, нагрузочные и автотесты). Отсутствие метки = real.
SQL_EXCLUDED_USERS = """
SELECT id::text FROM users WHERE properties->>'traffic_type' IN ('test', 'internal')
"""

# Отметка первого сообщения из счётчика реплик (у legacy-аккаунтов NULL — их покрывает SQL_FIRST_MESSAGE_DAY).
SQL_FIRST_REPLY = """
SELECT user_id::text, to_char((first_reply_at AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD')
FROM user_reply_counts WHERE first_reply_at IS NOT NULL
"""


def query_agent_db(dsn: str, since: datetime, until: datetime) -> dict:
    import psycopg  # импорт здесь, чтобы тесты чистых функций не требовали драйвера

    # Сессия только на чтение: в чужие базы сервис ничего не пишет, даже по ошибке.
    with psycopg.connect(dsn, options="-c default_transaction_read_only=on", connect_timeout=10) as conn:
        rows = [
            (r[0], str(r[1]), int(r[2]))
            for r in conn.execute(SQL_MESSAGES_BY_DAY, {"since": since, "until": until})
        ]
        first_message = {str(r[0]): r[1] for r in conn.execute(SQL_FIRST_MESSAGE_DAY)}
    return {"message_rows": rows, "first_message": first_message}


def query_app_db(dsn: str) -> dict:
    import psycopg

    with psycopg.connect(dsn, options="-c default_transaction_read_only=on", connect_timeout=10) as conn:
        excluded = {str(r[0]) for r in conn.execute(SQL_EXCLUDED_USERS)}
        first_reply = {str(r[0]): r[1] for r in conn.execute(SQL_FIRST_REPLY)}
    return {"excluded": excluded, "first_reply": first_reply}


def first_message_day(dsn: str) -> date | None:
    import psycopg

    with psycopg.connect(dsn, options="-c default_transaction_read_only=on", connect_timeout=10) as conn:
        row = conn.execute(SQL_FIRST_DAY_EVER).fetchone()
    return date.fromisoformat(row[0]) if row and row[0] else None


# ---------- источник: Langfuse ----------

def _langfuse_get(host: str, public_key: str, secret_key: str, path: str, params: dict) -> dict:
    url = host.rstrip("/") + path + "?" + urllib.parse.urlencode(params)
    auth = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
    request = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def _langfuse_list(host: str, public_key: str, secret_key: str, path: str, params: dict) -> list[dict]:
    """Постраничная выгрузка списка публичного API Langfuse за период."""
    items: list[dict] = []
    page = 1
    while True:
        body = _langfuse_get(host, public_key, secret_key, path, {**params, "page": page, "limit": LANGFUSE_PAGE_LIMIT})
        items.extend(body.get("data") or [])
        meta = body.get("meta") or {}
        if page >= int(meta.get("totalPages") or 1):
            return items
        page += 1


def query_langfuse(host: str, public_key: str, secret_key: str, since: datetime, until: datetime) -> dict:
    """Записи GENERATION и TOOL и трассы за период. userId живёт на трассе, связь — по traceId."""

    def stamp(at: datetime) -> str:
        return at.strftime("%Y-%m-%dT%H:%M:%SZ")
    generations = _langfuse_list(host, public_key, secret_key, "/api/public/observations",
                                 {"type": "GENERATION", "fromStartTime": stamp(since), "toStartTime": stamp(until)})
    tools = _langfuse_list(host, public_key, secret_key, "/api/public/observations",
                           {"type": "TOOL", "fromStartTime": stamp(since), "toStartTime": stamp(until)})
    traces = _langfuse_list(host, public_key, secret_key, "/api/public/traces",
                            {"fromTimestamp": stamp(since - TRACE_LOOKBACK), "toTimestamp": stamp(until)})
    return {"generations": generations, "tools": tools, "traces": traces}


def collect_raw(since: datetime, until: datetime) -> dict:
    """Сырые данные для снимков за [since, until): базы agent и app (чтение) и Langfuse."""
    raw = query_agent_db(os.environ["DIALOG_DATABASE_URL"], since, until)
    raw.update(query_app_db(os.environ["APP_DATABASE_URL"]))
    raw.update(query_langfuse(
        os.environ.get("LANGFUSE_HOST", "http://langfuse-web.infra.svc.cluster.local:3000"),
        os.environ["LANGFUSE_PUBLIC_KEY"],
        os.environ["LANGFUSE_SECRET_KEY"],
        since,
        until,
    ))
    return raw


# ---------- хранилище снимков (собственная база дашборда) ----------

SNAPSHOT_DDL = """
CREATE TABLE IF NOT EXISTS daily_metrics (
    day date PRIMARY KEY,
    dau integer NOT NULL,
    daily_active_account integer NOT NULL,
    new_users integer NOT NULL,
    total_users integer NOT NULL,
    llm_requests integer NOT NULL,
    tool_requests integer NOT NULL,
    computed_at timestamptz NOT NULL
)
"""

# Снимок пишется один раз: повторный запуск не переписывает прошлое даже при ошибке в коде расчёта.
SNAPSHOT_INSERT = """
INSERT INTO daily_metrics (day, dau, daily_active_account, new_users, total_users, llm_requests, tool_requests, computed_at)
VALUES (%(day)s, %(dau)s, %(daily_active_account)s, %(new_users)s, %(total_users)s, %(llm_requests)s, %(tool_requests)s, %(computed_at)s)
ON CONFLICT (day) DO NOTHING
"""


class PgSnapshotStore:
    """Снимки в собственной базе дашборда: единственное место, куда сервис пишет. Хранятся только агрегаты."""

    def __init__(self, dsn: str):
        self._dsn = dsn

    def _connect(self):
        import psycopg

        return psycopg.connect(self._dsn, connect_timeout=10)

    def ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(SNAPSHOT_DDL)

    def days(self) -> set[str]:
        with self._connect() as conn:
            return {r[0].isoformat() for r in conn.execute("SELECT day FROM daily_metrics")}

    def total_before(self, day: str) -> int:
        """total_users последнего снимка строго раньше `day` (0, если снимков раньше нет)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT total_users FROM daily_metrics WHERE day < %(day)s ORDER BY day DESC LIMIT 1", {"day": day}
            ).fetchone()
        return int(row[0]) if row else 0

    def insert(self, row: dict) -> bool:
        """Записать снимок; False, если день уже закрыт (ON CONFLICT DO NOTHING)."""
        with self._connect() as conn:
            cursor = conn.execute(SNAPSHOT_INSERT, row)
        return cursor.rowcount > 0

    def load(self, days: list[str]) -> dict[str, dict]:
        """Снимки перечисленных дней: {день: {метрики}}."""
        if not days:
            return {}
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT day, dau, daily_active_account, new_users, total_users, llm_requests, tool_requests "
                "FROM daily_metrics WHERE day = ANY(%(days)s)",
                {"days": days},
            ).fetchall()
        return {
            r[0].isoformat(): {
                "dau": int(r[1]),
                "daily_active_account": int(r[2]),
                "new_users": int(r[3]),
                "total_users": int(r[4]),
                "llm_requests": int(r[5]),
                "tool_requests": int(r[6]),
            }
            for r in rows
        }


def save_snapshots(store, days: list[str], metrics: Mapping[str, dict], computed_at: datetime) -> int:
    """Записать снимки дней по возрастанию. total_users = итог предыдущего снимка + new_users дня.

    Дни идут по возрастанию, поэтому записанный в этом же цикле снимок участвует в накоплении следующих;
    уже существующие снимки не перезаписываются (insert возвращает False)."""
    written = 0
    for day in sorted(days):
        m = metrics.get(day) or ZERO_METRICS
        row = {
            "day": day,
            "dau": m["dau"],
            "daily_active_account": m["daily_active_account"],
            "new_users": m["new_users"],
            "total_users": store.total_before(day) + m["new_users"],
            "llm_requests": m["llm_requests"],
            "tool_requests": m["tool_requests"],
            "computed_at": computed_at,
        }
        if store.insert(row):
            written += 1
    return written


# ---------- закрытие суток ----------

def missing_days(now: datetime, existing: set[str]) -> list[str]:
    """Прошедшие сутки периода без снимка, которые уже можно закрыть: вчерашние — только после 00:15 МСК.

    Текущие сутки снимком не закрываются никогда: их предварительные данные считаются при отдаче отчёта."""
    days = period_days(now)[:-1]
    if not days:
        return []
    local = now.astimezone(MSK)
    closable = (local.hour, local.minute) >= (CLOSE_HOUR, CLOSE_MINUTE)
    return [d.isoformat() for d in days if d.isoformat() not in existing and (d < days[-1] or closable)]


def seconds_until_close(now: datetime) -> float:
    """Секунд до ближайшего закрытия суток (00:15 МСК)."""
    local = now.astimezone(MSK)
    target = local.replace(hour=CLOSE_HOUR, minute=CLOSE_MINUTE, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return max((target - local).total_seconds(), 60.0)


class Snapshotter:
    """Фоновое закрытие суток: catch-up пробелов при старте, дальше — после 00:15 МСК каждый день."""

    def __init__(self, store, collect: Callable[[datetime, datetime], dict],
                 now: Callable[[], datetime] = lambda: datetime.now(UTC), sleep: Callable[[float], None] = time.sleep):
        self._store, self._collect, self._now, self._sleep = store, collect, now, sleep

    def close_due(self) -> int:
        """Досчитать и записать все доступные для закрытия дни без снимка. Сколько снимков записано.

        Дни идут ограниченными окнами по возрастанию с записью снимков после каждого окна: вся история
        одним запросом в память не собирается, цепочка total_users наращивается по записанным снимкам."""
        pending = missing_days(self._now(), self._store.days())
        written = 0
        first_turn: dict[str, str] = {}  # первые live-turn дни: накапливаются через окна, чтобы не посчитать новым дважды
        for i in range(0, len(pending), SNAPSHOT_WINDOW_DAYS):
            window = pending[i:i + SNAPSHOT_WINDOW_DAYS]
            since, until = utc_bounds([date.fromisoformat(window[0]), date.fromisoformat(window[-1])])
            started = time.monotonic()
            raw = self._collect(since, until)
            _fold_first_turns(first_turn, raw)
            metrics = metrics_by_day(**raw, first_turn=first_turn)
            written += save_snapshots(self._store, window, metrics, self._now())
            log.info("снимки за %s–%s: всего записано %s, %.1f с",
                     window[0], window[-1], written, time.monotonic() - started)
        return written

    def run_forever(self) -> None:
        delay = 0.0
        while True:
            if delay:
                self._sleep(delay)
            try:
                self.close_due()
                delay = seconds_until_close(self._now())
            except Exception:  # любой сбой источников: страница продолжает жить на снимках
                log.exception("снимок не удался, повтор через %s с", SNAPSHOT_RETRY_SECONDS)
                delay = SNAPSHOT_RETRY_SECONDS


# ---------- backfill истории ----------


def backfill(store, collect: Callable[[datetime, datetime], dict], first_day: date, now: datetime,
             window_days: int = SNAPSHOT_WINDOW_DAYS) -> int:
    """Досчёт истории от первого сохранённого сообщения до вчера. Пишет только дни без снимка.

    История идёт окнами по `window_days` дней по возрастанию: выгрузка источников ограничена окном,
    снимки окна сохраняются до перехода к следующему — цепочка total_users наращивается по уже
    записанным снимкам и остаётся аддитивной. Идемпотентно: дни со снимком пропускаются.
    Текущие сутки не закрываются: их предварительные данные считаются при отдаче отчёта."""
    yesterday = now.astimezone(MSK).date() - timedelta(days=1)
    if first_day > yesterday:
        return 0
    existing = store.days()
    written = 0
    start = first_day
    first_turn: dict[str, str] = {}  # первые live-turn дни: накапливаются через окна, чтобы не посчитать новым дважды
    while start <= yesterday:
        end = min(start + timedelta(days=window_days - 1), yesterday)
        days = []
        day = start
        while day <= end:
            days.append(day.isoformat())
            day += timedelta(days=1)
        pending = [d for d in days if d not in existing]
        if pending:
            since, until = utc_bounds([start, end])
            raw = collect(since, until)
            _fold_first_turns(first_turn, raw)
            metrics = metrics_by_day(**raw, first_turn=first_turn)
            written += save_snapshots(store, pending, metrics, now)
        start = end + timedelta(days=1)
    return written


def run_backfill() -> int:
    store = PgSnapshotStore(os.environ["DASHBOARD_DATABASE_URL"])
    store.ensure_schema()
    first = first_message_day(os.environ["DIALOG_DATABASE_URL"])
    if first is None:
        log.info("backfill: сообщений в базе агента нет, считать нечего")
        return 0
    written = backfill(store, collect_raw, first, datetime.now(UTC))
    log.info("backfill: записано %s снимков", written)
    return written


# ---------- отчёт: снимки прошлых суток + предварительный расчёт текущих ----------

def build_report(days: list[date], snapshots: Mapping[str, dict], computed_at: datetime) -> dict:
    """Отчёт за период из снимков (текущие сутки подкладывает вызывающий как предварительную строку).

    День без данных (catch-up ещё не добежал) — нули, total_users повторяет накануне."""
    out = []
    total = 0
    for d in days:
        key = d.isoformat()
        snap = snapshots.get(key)
        if snap is not None:
            total = snap["total_users"]
            out.append({"date": key, **{f: snap[f] for f in METRIC_FIELDS}, "total_users": total})
        else:
            out.append({"date": key, **ZERO_METRICS, "total_users": total})
    return {
        "period": {"from": days[0].isoformat(), "to": days[-1].isoformat(), "timezone": "Europe/Moscow"},
        "updated_at": computed_at.astimezone(MSK).isoformat(timespec="minutes"),
        "definitions": definitions(),
        "days": out,
    }


def compute_report(now: datetime) -> dict:
    """Отчёт: прошедшие сутки — только неизменяемые снимки, текущие — предварительный расчёт из сырых источников.

    Строка текущих суток в daily_metrics не пишется: до закрытия в 00:15 МСК данные дня ещё меняются.
    Её total_users — накопленный итог последнего снимка до сегодня плюс предварительные new_users дня."""
    days = period_days(now)
    store = PgSnapshotStore(os.environ["DASHBOARD_DATABASE_URL"])
    snapshots = store.load([d.isoformat() for d in days])
    today = days[-1].isoformat()
    metrics = metrics_by_day(**collect_raw(*utc_bounds([days[-1], days[-1]]))).get(today) or ZERO_METRICS
    snapshots[today] = {**metrics, "total_users": store.total_before(today) + metrics["new_users"]}
    return build_report(days, snapshots, now)


class ReportCache:
    """Один пересчёт в час на весь процесс; пока идёт пересчёт, остальные ждут его же результата."""

    def __init__(self, compute: Callable[[datetime], dict], ttl: float = CACHE_SECONDS,
                 clock: Callable[[], float] = time.monotonic, now: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self._compute, self._ttl, self._clock, self._now = compute, ttl, clock, now
        self._lock = threading.Lock()
        self._report: dict | None = None
        self._at = 0.0

    def get(self) -> dict:
        with self._lock:
            fresh = self._report is not None and self._clock() - self._at < self._ttl
            # Сутки сменились — прошлый период уже не тот, пересчитываем сразу.
            same_period = self._report is not None and self._report["period"]["to"] == period_days(self._now())[-1].isoformat()
            if fresh and same_period:
                return self._report
            try:
                self._report = self._compute(self._now())
                self._at = self._clock()
            except Exception:  # любой сбой хранилища: отдаём прошлое
                log.exception("пересчёт не удался")
                if self._report is None:
                    raise
                # Отдаём последнее удачное, а не ошибку: следующий запрос попробует снова.
            return self._report


# ---------- доступ ----------

class FailedLogins:
    """Неудачные входы по IP за текущую минуту: пароль простой, перебор надо тормозить."""

    def __init__(self, limit: int = FAILED_LOGINS_PER_MINUTE, clock: Callable[[], float] = time.time):
        self._limit, self._clock = limit, clock
        self._lock = threading.Lock()
        self._minute = -1
        self._counts: dict[str, int] = {}

    def _roll(self) -> None:
        minute = int(self._clock() // 60)
        if minute != self._minute:
            self._minute, self._counts = minute, {}

    def blocked(self, ip: str) -> bool:
        with self._lock:
            self._roll()
            return self._counts.get(ip, 0) >= self._limit

    def fail(self, ip: str) -> None:
        with self._lock:
            self._roll()
            self._counts[ip] = self._counts.get(ip, 0) + 1


def credentials_ok(header: str | None, user: str, password: str) -> bool:
    if not header or not header.startswith("Basic ") or not password:
        return False
    try:
        given_user, _, given_password = base64.b64decode(header[6:].strip()).decode("utf-8").partition(":")
    except (ValueError, UnicodeDecodeError):
        return False
    # Оба сравнения выполняются всегда: время ответа не подсказывает, что из двух неверно.
    user_ok = hmac.compare_digest(given_user.encode(), user.encode())
    password_ok = hmac.compare_digest(given_password.encode(), password.encode())
    return user_ok and password_ok


# ---------- страница ----------

def chart(days: list[dict], key: str, title: str, color: str) -> str:
    width, height, left, bottom, top = 640, 170, 8, 22, 18
    values = [d[key] for d in days]
    peak = max(values + [1])
    step = (width - left * 2) / len(days)
    bar = min(48, step * 0.6)
    parts = []
    for i, d in enumerate(days):
        value = d[key]
        h = (height - bottom - top) * value / peak
        x = left + step * i + (step - bar) / 2
        y = height - bottom - h
        # последний день периода — текущие сутки, их данные предварительные
        label = d["date"][8:10] + "." + d["date"][5:7] + ("*" if i == len(days) - 1 else "")
        parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar:.1f}" height="{max(h, 1):.1f}" rx="3" fill="{color}"/>'
            f'<text class="v" x="{x + bar / 2:.1f}" y="{y - 5:.1f}" text-anchor="middle">{value}</text>'
            f'<text x="{x + bar / 2:.1f}" y="{height - 6}" text-anchor="middle">{label}</text>'
        )
    return (
        f'<section><h2>{html.escape(title)}</h2>'
        f'<svg viewBox="0 0 {width} {height}" width="100%" role="img" aria-label="{html.escape(title)}">{"".join(parts)}</svg></section>'
    )


def render_page(report: dict) -> str:
    days = report["days"]
    # последний день периода — текущие сутки: строка предварительная, помечается звёздочкой
    rows = "".join(
        f'<tr><td>{d["date"][8:10]}.{d["date"][5:7]}.{d["date"][:4]}{"*" if i == len(days) - 1 else ""}</td><td>{d["dau"]}</td>'
        f'<td>{d["daily_active_account"]}</td><td>{d["new_users"]}</td><td>{d["total_users"]}</td>'
        f'<td>{d["llm_requests"]}</td><td>{d["tool_requests"]}</td></tr>'
        for i, d in enumerate(days)
    )
    avg_dau = sum(d["dau"] for d in days) / len(days)
    total_new = sum(d["new_users"] for d in days)
    total_llm = sum(d["llm_requests"] for d in days)
    total_tool = sum(d["tool_requests"] for d in days)
    p = report["period"]
    period = f'{p["from"][8:10]}.{p["from"][5:7]}–{p["to"][8:10]}.{p["to"][5:7]}.{p["to"][:4]}'
    defs = report["definitions"]
    definitions_html = "".join(f"<li>{html.escape(defs[key])}</li>" for key in
                               ("dau", "daily_active_account", "new_users", "total_users", "llm_requests", "tool_requests"))
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Слышу Рядом — метрики</title>
<style>
:root {{ --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --a:#2f6fdf; --b:#d9822b; --c:#2e9d6a; --d:#8e5ad7; --e:#d14d6e; --f:#4a90a4; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#141416; --fg:#f2f2f4; --muted:#a1a1a8; --line:#2c2c30; --a:#6b9bff; --b:#f0a65a; --c:#4cc38a; --d:#b18cff; --e:#ff7d9c; --f:#7fc4d8; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; padding:20px 16px 32px; background:var(--bg); color:var(--fg);
  font:15px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }}
main {{ max-width:760px; margin:0 auto; }}
h1 {{ font-size:22px; margin:0 0 4px; }} h2 {{ font-size:16px; margin:22px 0 6px; }}
.muted {{ color:var(--muted); font-size:13px; }}
.kpi {{ display:flex; flex-wrap:wrap; gap:10px; margin:16px 0 4px; }}
.kpi div {{ flex:1 1 150px; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }}
.kpi b {{ display:block; font-size:22px; }}
svg text {{ fill:var(--muted); font-size:12px; }} svg text.v {{ fill:var(--fg); font-weight:600; }}
table {{ display:block; width:100%; overflow-x:auto; border-collapse:collapse; margin-top:22px; font-variant-numeric:tabular-nums; }}
th, td {{ padding:8px 6px; border-bottom:1px solid var(--line); text-align:right; }}
th:first-child, td:first-child {{ text-align:left; }} th {{ font-size:13px; color:var(--muted); font-weight:600; }}
ul {{ padding-left:18px; }} li {{ margin:4px 0; }}
</style></head>
<body><main>
<h1>Слышу Рядом — метрики</h1>
<div class="muted">{period}, сутки по Москве · обновлено {html.escape(report["updated_at"][11:16])} МСК {report["updated_at"][8:10]}.{report["updated_at"][5:7]} · * текущие сутки — предварительные данные</div>
<div class="kpi">
<div><span class="muted">DAU в среднем за сутки</span><b>{f"{avg_dau:.1f}".replace(".", ",")}</b></div>
<div><span class="muted">Новых за период</span><b>{total_new}</b></div>
<div><span class="muted">Пользователей на {p["to"][8:10]}.{p["to"][5:7]}*</span><b>{days[-1]["total_users"]}</b></div>
<div><span class="muted">Вызовов LLM за период</span><b>{total_llm}</b></div>
<div><span class="muted">Tool calls — Память, за период</span><b>{total_tool}</b></div>
</div>
{chart(days, "dau", "DAU — активные за сутки", "var(--a)")}
{chart(days, "daily_active_account", "Активные аккаунты (>10 сообщений)", "var(--d)")}
{chart(days, "new_users", "Новые пользователи", "var(--e)")}
{chart(days, "total_users", "Пользователи, всего", "var(--c)")}
{chart(days, "llm_requests", "Вызовы LLM", "var(--b)")}
{chart(days, "tool_requests", "Tool calls — Память", "var(--f)")}
<table><thead><tr><th>Дата</th><th>DAU</th><th>Активные (&gt;10)</th><th>Новые</th><th>Всего</th><th>LLM</th><th>Память</th></tr></thead>
<tbody>{rows}</tbody></table>
<h2>Как считается</h2>
<ul>{definitions_html}<li>Из метрик исключён трафик test/internal. Сообщения для DAU и «активных» считаются по базе агента и трейсингу Langfuse вместе: часть истории в базе не сохранилась, поэтому ходы диалога восстанавливаются из трассы (одна трасса — одно сообщение), а для пары «день, аккаунт» берётся большее из двух чисел — одни и те же ходы дважды не считаются. Прошедшие сутки закрываются снимком в 00:15 МСК и дальше не пересчитываются; текущие сутки (со звёздочкой) — предварительные данные из сырых источников, снимком пока не закрываются. Страница обновляется не чаще раза в час. JSON с теми же числами — <code>/dashboard/api</code>.</li></ul>
</main></body></html>"""


# ---------- HTTP ----------

USER = os.environ.get("DASHBOARD_USER", "sber500")
PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
CACHE = ReportCache(compute_report)
FAILED = FailedLogins()


class Handler(BaseHTTPRequestHandler):
    server_version = "dashboard"
    sys_version = ""
    timeout = 30  # медленный клиент не держит поток дольше

    def _client_ip(self) -> str:
        headers = getattr(self, "headers", None)  # у неразобранного запроса заголовков ещё нет
        forwarded = headers.get("X-Forwarded-For", "") if headers else ""
        return forwarded.split(",")[0].strip() or self.client_address[0]

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/healthz":
            return self._send(200, b"ok", "text/plain; charset=utf-8")
        if path not in ("/dashboard", "/dashboard/api"):
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        ip = self._client_ip()
        if FAILED.blocked(ip):
            return self._send(429, "Слишком много попыток входа, подождите минуту".encode(), "text/plain; charset=utf-8")
        if not credentials_ok(self.headers.get("Authorization"), USER, PASSWORD):
            if self.headers.get("Authorization"):
                FAILED.fail(ip)
                log.warning("неверный вход с %s", ip)
            return self._send(401, "Нужен вход".encode(), "text/plain; charset=utf-8",
                              {"WWW-Authenticate": 'Basic realm="ryadom-dashboard", charset="UTF-8"'})
        try:
            report = CACHE.get()
        except Exception:  # noqa: BLE001 (без данных — 503, а не обрыв соединения)
            return self._send(503, "Данные временно недоступны".encode(), "text/plain; charset=utf-8")
        if path == "/dashboard/api":
            return self._send(200, json.dumps(report, ensure_ascii=False).encode(), "application/json; charset=utf-8")
        return self._send(200, render_page(report).encode(), "text/html; charset=utf-8")

    def log_message(self, format: str, *args) -> None:
        # Журнал доступа без заголовков: в них пароль.
        log.info("%s %s", self._client_ip(), format % args)


def _require_env(*names: str) -> None:
    for name in names:
        if not os.environ.get(name):
            raise SystemExit(f"{name} не задан")


def main() -> None:
    if "--backfill" in sys.argv[1:]:
        _require_env("DIALOG_DATABASE_URL", "APP_DATABASE_URL", "DASHBOARD_DATABASE_URL",
                     "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")
        run_backfill()
        return
    if not PASSWORD:
        raise SystemExit("DASHBOARD_PASSWORD не задан")
    _require_env("DIALOG_DATABASE_URL", "APP_DATABASE_URL", "DASHBOARD_DATABASE_URL",
                 "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY")
    store = PgSnapshotStore(os.environ["DASHBOARD_DATABASE_URL"])
    store.ensure_schema()
    snapshotter = Snapshotter(store, collect_raw)
    threading.Thread(target=snapshotter.run_forever, daemon=True).start()
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    log.info("слушаю :%s", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
