"""Чистые функции дашборда: период, метрики из сырых выгрузок, снимки, backfill, кэш, вход.

Новые тесты помечены: openspec/changes/update-sber500-dashboard-metrics, «<требование>».
Хранилище снимков в тестах — in-memory FakeStore с тем же интерфейсом, что у PgSnapshotStore.
"""

import base64
import sys
from datetime import UTC, date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app

NOW = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)  # 12:00 МСК: закрытие суток (00:15 МСК) уже прошло


class FakeStore:
    """In-memory хранилище снимков с семантикой ON CONFLICT DO NOTHING."""

    def __init__(self, rows=()):
        self.rows = {r["day"]: dict(r) for r in rows}

    def days(self):
        return set(self.rows)

    def total_before(self, day):
        earlier = [r for d, r in self.rows.items() if d < day]
        return max(earlier, key=lambda r: r["day"])["total_users"] if earlier else 0

    def insert(self, row):
        if row["day"] in self.rows:
            return False
        self.rows[row["day"]] = dict(row)
        return True

    def load(self, days):
        return {d: dict(self.rows[d]) for d in days if d in self.rows}

    def tool_recovery(self):
        return {}


def empty_raw():
    return {"message_rows": [], "first_message": {}, "excluded": set(), "first_reply": {},
            "generations": [], "tools": [], "traces": []}


def snapshot_row(day, dau=0, daily_active_account=0, new_users=0, total_users=0, llm_requests=0, tool_requests=0):
    return {"day": day, "dau": dau, "daily_active_account": daily_active_account, "new_users": new_users,
            "total_users": total_users, "llm_requests": llm_requests, "tool_requests": tool_requests,
            "computed_at": NOW}


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


# ---------- период ----------

def test_period_starts_on_contest_launch_and_includes_today():
    # Весь конкурс: фиксированная левая граница 2026-11-05, правая — текущие московские сутки.
    # 11.11 01:30 по Москве = 10.11 22:30 UTC.
    days = app.period_days(datetime(2026, 11, 10, 22, 30, tzinfo=UTC))
    assert days[0] == date(2026, 11, 5) and days[-1] == date(2026, 11, 11) and len(days) == 7


def test_period_includes_today_even_before_close():
    # До 00:15 МСК вчерашние сутки ещё не закрыты снимком, но текущие уже входят в период
    # как предварительные. 11.11 00:10 МСК = 10.11 21:10 UTC.
    days = app.period_days(datetime(2026, 11, 10, 21, 10, tzinfo=UTC))
    assert days[0] == date(2026, 11, 5) and days[-1] == date(2026, 11, 11)


def test_period_before_contest_is_single_today():
    days = app.period_days(datetime(2026, 11, 3, 12, 0, tzinfo=UTC))  # 03.11 15:00 МСК, конкурс ещё не начался
    assert days == [date(2026, 11, 3)]


def test_bounds_are_moscow_midnights_in_utc():
    since, until = app.utc_bounds([date(2026, 11, 4), date(2026, 11, 10)])
    assert since == datetime(2026, 11, 3, 21, tzinfo=UTC)
    assert until == datetime(2026, 11, 10, 21, tzinfo=UTC)


def test_msk_day_folds_utc_timestamps():
    assert app.msk_day("2026-11-04T20:59:59Z") == "2026-11-04"
    assert app.msk_day("2026-11-04T21:00:00.000Z") == "2026-11-05"
    # явный сдвиг зоны (в т.ч. отрицательный) парсится как есть, "Z" не подставляется
    assert app.msk_day("2026-11-04T18:30:00-05:00") == "2026-11-05"  # 23:30 UTC = 02:30 МСК следующих суток
    assert app.msk_day("2026-11-04T22:30:00+05:00") == "2026-11-04"  # 17:30 UTC = 20:30 МСК
    assert app.msk_day("") is None and app.msk_day("не дата") is None


# ---------- метрики из сырых выгрузок ----------

def test_dau_from_one_message_and_active_over_ten():
    # openspec/changes/update-sber500-dashboard-metrics, «Метрики по дням для Sber500»: dau — ≥1 сообщение,
    # daily_active_account — строго >10.
    rows = [("2026-11-10", "u1", 1), ("2026-11-10", "u2", 11), ("2026-11-10", "u3", 10)]
    dau, active = app.activity_by_day(rows, set())
    assert dau == {"2026-11-10": 3}
    assert active == {"2026-11-10": 1}  # u3 с ровно 10 не считается


def test_first_known_day_is_min_of_reply_mark_and_first_message():
    # openspec/changes/update-sber500-dashboard-metrics, «Метрики по дням для Sber500»: первый день — меньшее
    # из first_reply_at и первого сохранённого сообщения; legacy-аккаунт с NULL first_reply_at — по сообщению.
    first_reply = {"legacy": None, "both": "2026-11-05", "only-mark": "2026-11-07"}
    first_message = {"legacy": "2026-10-01", "both": "2026-11-06"}
    assert app.first_known_day(first_reply, first_message) == {
        "legacy": "2026-10-01",  # NULL в счётчике — первое известное по базе агента
        "both": "2026-11-05",  # меньшее из двух отметок
        "only-mark": "2026-11-07",
    }


def test_llm_requests_count_conversation_calls_but_not_systemic():
    # openspec/changes/update-sber500-dashboard-metrics, «Вызванные разговором вызовы считаются, системные — нет».
    traces = [{"id": "t-user", "userId": "u1"}, {"id": "t-test", "userId": "tester"}, {"id": "t-nouser"}]
    observations = [
        {"name": "dialog_recap", "traceId": "t-user", "startTime": "2026-11-10T10:00:00Z"},
        {"name": "memory_extract", "traceId": "t-user", "startTime": "2026-11-10T10:01:00Z"},
        {"name": "memory_instruct", "traceId": "t-user", "startTime": "2026-11-10T10:02:00Z"},
        {"name": "mood_classify_sber", "traceId": "t-user", "startTime": "2026-11-10T10:03:00Z"},
        {"name": "mood_classify_gemini", "traceId": "t-user", "startTime": "2026-11-10T10:04:00Z"},
        {"name": "live_turn_voice", "traceId": "t-user", "startTime": "2026-11-10T10:05:00Z"},
        {"name": "live_turn_text", "traceId": "t-user", "startTime": "2026-11-10T10:06:00Z"},
        {"name": "weekly_digest", "traceId": "t-user", "startTime": "2026-11-10T11:00:00Z"},  # плановая сводка
        {"name": "gemini_tts_phrase", "traceId": "t-user", "startTime": "2026-11-10T11:01:00Z"},  # озвучка
        {"name": "text_turn", "traceId": "t-user", "startTime": "2026-11-10T11:02:00Z"},  # кризисный текст
        {"name": "mood_classify_sber", "traceId": "t-nouser", "startTime": "2026-11-10T11:03:00Z"},  # прогрев
        {"name": "mood_classify_sber", "startTime": "2026-11-10T11:04:00Z"},  # без трассы вовсе
        {"name": "live_turn_voice", "traceId": "t-test", "startTime": "2026-11-10T12:00:00Z"},  # test-аккаунт
    ]
    assert app.llm_requests_by_day(observations, traces, {"tester"}) == {"2026-11-10": 7}


def test_recovery_retry_is_not_a_new_call():
    # openspec/changes/update-sber500-dashboard-metrics, «Ретраи — один вызов»: live_turn_recovery — технический
    # повтор уже посчитанного хода, отдельной записи в метрике не даёт.
    traces = [{"id": "t1", "userId": "u1"}]
    observations = [
        {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-10T10:00:00Z"},
        {"name": "live_turn_recovery", "traceId": "t1", "startTime": "2026-11-10T10:00:30Z"},
        {"name": "live_turn_recovery", "traceId": "t1", "startTime": "2026-11-10T10:01:00Z"},
    ]
    assert app.llm_requests_by_day(observations, traces, set()) == {"2026-11-10": 1}


def test_tool_requests_only_successful_known_operations():
    # openspec/changes/update-sber500-dashboard-metrics, «Ошибки вызовов памяти не считаются» и
    # «Метрики по дням для Sber500» (tool_requests).
    traces = [{"id": "t-user", "userId": "u1"}, {"id": "t-test", "userId": "tester"}]
    observations = [
        {"name": "memory_search", "traceId": "t-user", "startTime": "2026-11-10T10:00:00Z"},
        {"name": "memory_write", "traceId": "t-user", "startTime": "2026-11-10T10:01:00Z", "level": "DEFAULT"},
        {"name": "memory_delete_document", "traceId": "t-user", "startTime": "2026-11-10T10:02:00Z"},
        {"name": "memory_forget_dataset", "traceId": "t-user", "startTime": "2026-11-10T10:03:00Z"},
        {"name": "memory_search", "traceId": "t-user", "startTime": "2026-11-10T10:04:00Z", "level": "ERROR"},
        {"name": "memory_write", "traceId": "t-user", "startTime": "2026-11-10T10:05:00Z", "level": "ERROR"},
        {"name": "cognee_login", "traceId": "t-user", "startTime": "2026-11-10T10:06:00Z"},  # служебное имя
        {"name": "memory_search", "traceId": "t-test", "startTime": "2026-11-10T10:07:00Z"},  # test-аккаунт
        {"name": "memory_search", "startTime": "2026-11-10T10:08:00Z"},  # без userId на трассе
    ]
    assert app.tool_requests_by_day(observations, traces, {"tester"}) == {"2026-11-10": 4}


def test_langfuse_traces_lookback_beyond_observation_window(monkeypatch):
    # openspec/changes/update-sber500-dashboard-metrics, «Метрики по дням для Sber500»: трассы выгружаются
    # с lookback 24 часа назад от окна observations, чтобы observation на границе суток не теряла userId;
    # дублей нет — считаются только observations своего окна.
    calls = []

    def fake_list(host, public_key, secret_key, path, params):
        calls.append((path, params))
        return []

    monkeypatch.setattr(app, "_langfuse_list", fake_list)
    since, until = datetime(2026, 11, 3, 21, tzinfo=UTC), datetime(2026, 11, 10, 21, tzinfo=UTC)
    assert app.query_langfuse("http://lf", "pk", "sk", since, until) == {"generations": [], "tools": [], "traces": []}
    observations = [params for path, params in calls if path == "/api/public/observations"]
    traces = [params for path, params in calls if path == "/api/public/traces"]
    assert {params["type"] for params in observations} == {"GENERATION", "TOOL"}
    for params in observations:
        assert params["fromStartTime"] == "2026-11-03T21:00:00Z" and params["toStartTime"] == "2026-11-10T21:00:00Z"
    assert len(traces) == 1
    assert traces[0]["fromTimestamp"] == "2026-11-02T21:00:00Z"  # since минус 24 часа
    assert traces[0]["toTimestamp"] == "2026-11-10T21:00:00Z"


def test_metrics_by_day_fold_into_moscow_days():
    # openspec/changes/update-sber500-dashboard-metrics, «Метрики по дням для Sber500»: сутки — Europe/Moscow.
    raw = empty_raw()
    raw["message_rows"] = [("2026-11-09", "u1", 2), ("2026-11-10", "u1", 1)]
    raw["generations"] = [{"name": "live_turn_text", "traceId": "t1", "startTime": "2026-11-09T20:30:00Z"}]  # 23:30 МСК
    raw["traces"] = [{"id": "t1", "userId": "u1"}]
    metrics = app.metrics_by_day(**raw)
    assert metrics["2026-11-09"]["dau"] == 1 and metrics["2026-11-09"]["llm_requests"] == 1
    assert metrics["2026-11-10"]["dau"] == 1 and metrics["2026-11-10"]["llm_requests"] == 0


def test_name_lists_are_fixed_and_non_overlapping_with_excluded():
    # openspec/changes/update-sber500-dashboard-metrics, ревизия перечней (задача 6.12): списки непусты,
    # системные/технические имена в пользовательский список не входят.
    assert app.LLM_NAMES and app.TOOL_NAMES
    for name in ("text_turn", "live_turn_recovery", "gemini_tts_phrase", "weekly_digest"):
        assert name not in app.LLM_NAMES
    assert "memory_search" in app.TOOL_NAMES and "memory_forget_dataset" in app.TOOL_NAMES


# ---------- восстановление сообщений из Langfuse ----------

def test_same_trace_generations_do_not_duplicate_message():
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # дедупликация по (московский день, аккаунт, traceId): повторная GENERATION той же трассы —
    # не новое сообщение, две разные трассы — два сообщения.
    traces = [{"id": "t1", "userId": "u1"}, {"id": "t2", "userId": "u1"}]
    generations = [
        {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-10T10:00:00Z"},
        {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-10T10:00:20Z"},  # ретрай той же трассы
        {"name": "live_turn_text", "traceId": "t2", "startTime": "2026-11-10T11:00:00Z"},
    ]
    assert app.langfuse_message_rows(generations, traces, set()) == [("2026-11-10", "u1", 2)]


def test_recovery_recap_and_tool_records_are_not_messages():
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # сообщение — только live_turn_voice/live_turn_text; recovery (ретрай хода), вызванные разговором
    # вызовы (итог, настроение, память) и записи TOOL сообщением не считаются.
    traces = [{"id": "t1", "userId": "u1"}]
    generations = [
        {"name": "live_turn_recovery", "traceId": "t1", "startTime": "2026-11-10T10:00:00Z"},
        {"name": "dialog_recap", "traceId": "t1", "startTime": "2026-11-10T10:01:00Z"},
        {"name": "mood_classify_sber", "traceId": "t1", "startTime": "2026-11-10T10:02:00Z"},
        {"name": "memory_extract", "traceId": "t1", "startTime": "2026-11-10T10:03:00Z"},
    ]
    tools = [{"name": "memory_search", "traceId": "t1", "startTime": "2026-11-10T10:04:00Z"}]
    assert app.langfuse_message_rows(generations, traces, set()) == []
    raw = empty_raw()
    raw.update({"generations": generations, "tools": tools, "traces": traces})
    metrics = app.metrics_by_day(**raw)
    assert metrics["2026-11-10"]["dau"] == 0 and metrics["2026-11-10"]["daily_active_account"] == 0


def test_db_and_langfuse_merge_takes_max_not_sum():
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # база и Langfuse описывают одни и те же ходы — для пары «день, аккаунт» берётся max, а не сумма.
    merged = app.merge_message_rows([("2026-11-10", "u1", 8), ("2026-11-10", "u2", 5)],
                                    [("2026-11-10", "u1", 12)])
    assert {(d, u): n for d, u, n in merged} == {("2026-11-10", "u1"): 12, ("2026-11-10", "u2"): 5}  # не 8+12=20
    # max(8, 12) = 12 > 10 — аккаунт активный, хотя по одной сохранённой базе у него 8 сообщений
    raw = empty_raw()
    raw["message_rows"] = [("2026-11-10", "u1", 8)]
    raw["traces"] = [{"id": f"t{i}", "userId": "u1"} for i in range(12)]
    raw["generations"] = [{"name": "live_turn_voice", "traceId": f"t{i}", "startTime": f"2026-11-10T{i:02d}:00:00Z"}
                          for i in range(12)]
    metrics = app.metrics_by_day(**raw)
    assert metrics["2026-11-10"]["dau"] == 1
    assert metrics["2026-11-10"]["daily_active_account"] == 1


def test_empty_db_day_is_filled_from_langfuse():
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # день, которого нет в базе агента (11–16.11.2026 не сохранились), заполняется по трейсингу;
    # test/internal и трассы без userId при этом отбрасываются, как везде.
    raw = empty_raw()
    raw["excluded"] = {"tester"}
    raw["message_rows"] = [("2026-11-10", "u1", 3)]  # в базе есть только 10.11
    raw["traces"] = [{"id": "t1", "userId": "u1"}, {"id": "t2", "userId": "u2"},
                     {"id": "t3", "userId": "tester"}, {"id": "t4"}]
    raw["generations"] = [
        {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-12T09:00:00Z"},
        {"name": "live_turn_text", "traceId": "t2", "startTime": "2026-11-12T10:00:00Z"},
        {"name": "live_turn_voice", "traceId": "t3", "startTime": "2026-11-12T11:00:00Z"},  # test-аккаунт
        {"name": "live_turn_voice", "traceId": "t4", "startTime": "2026-11-12T12:00:00Z"},  # без userId
    ]
    metrics = app.metrics_by_day(**raw)
    assert metrics["2026-11-12"]["dau"] == 2  # дня нет в базе — заполнен из Langfuse
    assert metrics["2026-11-10"]["dau"] == 1


def test_first_known_day_from_earlier_langfuse_turn():
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # первый известный день — минимум трёх источников; более ранняя live-turn трасса сдвигает его назад,
    # аккаунт остаётся новым ровно один день.
    assert app.first_known_day({"u1": "2026-11-14"}, {"u1": "2026-11-16"}, {"u1": "2026-11-11"}) == {"u1": "2026-11-11"}
    raw = empty_raw()
    raw["first_message"] = {"u1": "2026-11-16"}
    raw["traces"] = [{"id": "t1", "userId": "u1"}]
    raw["generations"] = [{"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-11T09:00:00Z"}]
    metrics = app.metrics_by_day(**raw)
    assert metrics["2026-11-11"]["new_users"] == 1
    assert metrics.get("2026-11-16", app.ZERO_METRICS)["new_users"] == 0


# ---------- снимки ----------

def test_snapshot_insert_conflict_keeps_first_row():
    # openspec/changes/update-sber500-dashboard-metrics, «Удаление не переписывает прошлое»: повторная запись
    # дня не меняет строку (ON CONFLICT DO NOTHING).
    store = FakeStore()
    metrics = {"2026-11-10": {"dau": 5, "daily_active_account": 1, "new_users": 2, "llm_requests": 9, "tool_requests": 3}}
    assert app.save_snapshots(store, ["2026-11-10"], metrics, NOW) == 1
    first = dict(store.rows["2026-11-10"])
    changed = {"2026-11-10": {"dau": 100, "daily_active_account": 50, "new_users": 40, "llm_requests": 30, "tool_requests": 20}}
    assert app.save_snapshots(store, ["2026-11-10"], changed, NOW) == 0
    assert store.rows["2026-11-10"] == first


def test_total_users_accumulates_over_snapshots():
    # openspec/changes/update-sber500-dashboard-metrics, «Метрики по дням для Sber500»: total_users — итог
    # предыдущего снимка плюс new_users дня; «Сутки без активности»: пустой день не меняет итог.
    store = FakeStore([snapshot_row("2026-11-09", new_users=4, total_users=4)])
    metrics = {
        "2026-11-10": {"dau": 2, "daily_active_account": 0, "new_users": 3, "llm_requests": 5, "tool_requests": 1},
        "2026-11-11": {"dau": 0, "daily_active_account": 0, "new_users": 0, "llm_requests": 0, "tool_requests": 0},
    }
    assert app.save_snapshots(store, ["2026-11-10", "2026-11-11"], metrics, NOW) == 2
    assert store.rows["2026-11-10"]["total_users"] == 7
    assert store.rows["2026-11-11"]["total_users"] == 7  # день без активности: итог накануне


def test_snapshot_row_shape_is_only_aggregates():
    # openspec/changes/update-sber500-dashboard-metrics, «Хранятся только агрегаты»: дата, шесть целых, время расчёта.
    store = FakeStore()
    app.save_snapshots(store, ["2026-11-10"], {}, NOW)
    row = store.rows["2026-11-10"]
    assert set(row) == {"day", "dau", "daily_active_account", "new_users", "total_users",
                        "llm_requests", "tool_requests", "computed_at"}
    for field in ("dau", "daily_active_account", "new_users", "total_users", "llm_requests", "tool_requests"):
        assert isinstance(row[field], int)
    for column in ("dau", "daily_active_account", "new_users", "total_users", "llm_requests", "tool_requests"):
        assert f"{column} integer" in app.SNAPSHOT_DDL
    assert "text" not in app.SNAPSHOT_DDL and "varchar" not in app.SNAPSHOT_DDL


def test_missing_days_close_only_past_days_and_yesterday_only_after_0015_msk():
    # openspec/changes/update-sber500-dashboard-metrics, «Закрытие суток»: закрываются только прошедшие
    # сутки периода, вчерашние — после 00:15 МСК; текущие сутки снимком не закрываются никогда.
    before = datetime(2026, 11, 10, 21, 10, tzinfo=UTC)  # 11.11 00:10 МСК
    after = datetime(2026, 11, 10, 21, 20, tzinfo=UTC)  # 11.11 00:20 МСК
    assert app.missing_days(before, set()) == [f"2026-11-{d:02d}" for d in range(5, 10)]  # вчера ещё рано
    assert app.missing_days(after, set()) == [f"2026-11-{d:02d}" for d in range(5, 11)]
    assert "2026-11-11" not in app.missing_days(after, set())  # текущие сутки — не снимок


def test_catchup_fills_gaps_and_keeps_closed_days():
    # openspec/changes/update-sber500-dashboard-metrics, «Пробел закрывается сам»: дни без снимка досчитываются,
    # закрытые не пересчитываются (collect не зовётся ради них, строки не меняются), текущие сутки не пишутся.
    closed = snapshot_row("2026-11-05", dau=7, total_users=20)
    store = FakeStore([closed])
    calls = []

    def collect(since, until):
        calls.append((since, until))
        raw = empty_raw()
        raw["message_rows"] = [("2026-11-06", "u1", 1)]
        return raw

    snapshotter = app.Snapshotter(store, collect, now=lambda: NOW)
    assert snapshotter.close_due() == 5  # 11.06–11.10; 11.05 уже закрыт, 11.11 — текущие сутки
    assert store.rows["2026-11-05"] == closed
    assert store.rows["2026-11-06"]["dau"] == 1
    assert store.rows["2026-11-06"]["total_users"] == 20  # новых нет: u1 в first_message/first_reply не числится
    assert "2026-11-11" not in store.rows
    assert len(calls) == 1
    assert calls[0][0] == datetime(2026, 11, 5, 21, tzinfo=UTC)  # начало 11.06 по Москве
    assert snapshotter.close_due() == 0 and len(calls) == 1  # пробелов нет — источники не трогаем


def test_catchup_collects_history_in_bounded_windows(monkeypatch):
    # Catch-up после простоя не тянет всю историю одним запросом: окна ≤ SNAPSHOT_WINDOW_DAYS,
    # снимки каждого окна пишутся до перехода к следующему.
    monkeypatch.setattr(app, "SNAPSHOT_WINDOW_DAYS", 2)
    store = FakeStore()
    calls = []

    def collect(since, until):
        calls.append((since, until))
        return empty_raw()

    snapshotter = app.Snapshotter(store, collect, now=lambda: NOW)
    assert snapshotter.close_due() == 6  # 11.05–11.10
    assert calls == [
        (datetime(2026, 11, 4, 21, tzinfo=UTC), datetime(2026, 11, 6, 21, tzinfo=UTC)),  # 11.05–11.06
        (datetime(2026, 11, 6, 21, tzinfo=UTC), datetime(2026, 11, 8, 21, tzinfo=UTC)),  # 11.07–11.08
        (datetime(2026, 11, 8, 21, tzinfo=UTC), datetime(2026, 11, 10, 21, tzinfo=UTC)),  # 11.09–11.10
    ]


def test_test_traffic_gives_zero_day():
    # openspec/changes/update-sber500-dashboard-metrics, «Тестовый трафик исключён»: день только с test/internal
    # сообщениями, GENERATION и TOOL даёт нули по всем метрикам, кроме накопленного итога.
    raw = empty_raw()
    raw["excluded"] = {"tester", "bot"}
    raw["message_rows"] = [("2026-11-10", "tester", 30), ("2026-11-10", "bot", 2)]
    raw["first_message"] = {"tester": "2026-11-10"}
    raw["first_reply"] = {"bot": "2026-11-10"}
    raw["traces"] = [{"id": "t1", "userId": "tester"}, {"id": "t2", "userId": "bot"}]
    raw["generations"] = [{"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-10T10:00:00Z"}]
    raw["tools"] = [{"name": "memory_search", "traceId": "t2", "startTime": "2026-11-10T10:00:00Z"}]
    metrics = app.metrics_by_day(**raw)
    assert metrics.get("2026-11-10", app.ZERO_METRICS) == app.ZERO_METRICS
    store = FakeStore([snapshot_row("2026-11-09", new_users=5, total_users=5)])
    app.save_snapshots(store, ["2026-11-10"], metrics, NOW)
    assert store.rows["2026-11-10"]["total_users"] == 5  # total_users не растёт


def test_deleted_account_does_not_change_snapshots():
    # openspec/changes/update-sber500-dashboard-metrics, «Накопленный итог не уменьшается»: после закрытия суток
    # исчезновение аккаунта из сырых данных не меняет записанный снимок и отчёт.
    store = FakeStore()
    raw = empty_raw()
    raw["message_rows"] = [("2026-11-10", "u1", 3)]
    raw["first_message"] = {"u1": "2026-11-10"}
    app.save_snapshots(store, ["2026-11-10"], app.metrics_by_day(**raw), NOW)
    saved = dict(store.rows["2026-11-10"])
    assert saved["total_users"] == 1
    # аккаунт удалён: сырые данные пусты, но пересчёт уже закрытого дня запрещён хранилищем
    assert app.save_snapshots(store, ["2026-11-10"], app.metrics_by_day(**empty_raw()), NOW) == 0
    assert store.rows["2026-11-10"] == saved
    report = app.build_report([date(2026, 11, 10)], store.load(["2026-11-10"]), NOW)
    assert report["days"][0]["total_users"] == 1


# ---------- backfill ----------

def test_backfill_writes_history_once():
    # openspec/changes/update-sber500-dashboard-metrics, «Восстановление истории»: new_users — по первому
    # известному дню (legacy с NULL first_reply_at — по первому сообщению; аккаунт с двумя отметками — один раз,
    # в более ранний день); повторный запуск ничего не меняет. История идёт окнами ≤7 дней: вся выгрузка
    # Langfuse одним запросом в память не собирается, total_users наращивается через границу окон.
    store = FakeStore()
    calls = []

    def collect(since, until):
        calls.append((since, until))
        raw = empty_raw()
        raw["message_rows"] = [("2026-11-01", "legacy", 1), ("2026-11-05", "both", 1), ("2026-11-05", "legacy", 1)]
        raw["first_message"] = {"legacy": "2026-11-01", "both": "2026-11-05", "late": "2026-11-09"}
        raw["first_reply"] = {"legacy": None, "both": "2026-11-04"}
        return raw

    written = app.backfill(store, collect, date(2026, 11, 1), NOW)
    assert written == 10  # 11.01–11.10
    assert len(calls) == 2  # окна 11.01–11.07 и 11.08–11.10
    assert calls[0] == (datetime(2026, 10, 31, 21, tzinfo=UTC), datetime(2026, 11, 7, 21, tzinfo=UTC))
    assert calls[1] == (datetime(2026, 11, 7, 21, tzinfo=UTC), datetime(2026, 11, 10, 21, tzinfo=UTC))
    assert store.rows["2026-11-01"]["new_users"] == 1  # legacy: NULL first_reply_at → день первого сообщения
    assert store.rows["2026-11-04"]["new_users"] == 1  # both: более ранняя из двух отметок
    assert store.rows["2026-11-05"]["new_users"] == 0  # и только один день на аккаунта
    assert store.rows["2026-11-09"]["new_users"] == 1  # late: новый во втором окне
    assert store.rows["2026-11-07"]["total_users"] == 2  # конец первого окна
    assert store.rows["2026-11-10"]["total_users"] == 3  # накопление через границу окон
    assert "2026-11-11" not in store.rows  # текущие сутки снимком не закрываются
    assert app.backfill(store, collect, date(2026, 11, 1), NOW) == 0  # идемпотентно
    assert len(calls) == 2


def test_backfill_ends_yesterday_even_if_raw_has_today():
    # Backfill закрывает только прошедшие сутки: данные текущего дня из источников игнорируются.
    store = FakeStore()

    def collect(since, until):
        raw = empty_raw()
        raw["message_rows"] = [("2026-11-11", "u1", 5)]  # текущие сутки
        raw["first_message"] = {"u1": "2026-11-11"}
        return raw

    assert app.backfill(store, collect, date(2026, 11, 9), NOW) == 2  # 11.09 и 11.10
    assert store.rows["2026-11-10"]["dau"] == 0 and store.rows["2026-11-10"]["new_users"] == 0
    assert "2026-11-11" not in store.rows


def test_backfill_with_first_day_today_writes_nothing():
    # Прошедших суток в истории ещё нет — закрывать нечего.
    assert app.backfill(FakeStore(), lambda s, u: empty_raw(), date(2026, 11, 11), NOW) == 0


def test_backfill_keeps_existing_snapshots():
    # openspec/changes/update-sber500-dashboard-metrics, «Восстановление истории»: уже существующие снимки
    # не перезаписываются.
    existing = snapshot_row("2026-11-02", dau=9, total_users=42)
    store = FakeStore([existing])
    app.backfill(store, lambda s, u: empty_raw(), date(2026, 11, 1), NOW)
    assert store.rows["2026-11-02"] == existing
    assert "2026-11-01" in store.rows and "2026-11-10" in store.rows


def test_backfill_counts_langfuse_only_user_once_across_windows():
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # аккаунт, известный только по трейсингу (ни first_reply_at, ни сообщений в базе), считается новым
    # один раз — в день первой live-turn трассы; первые дни накапливаются через границу окон backfill.
    raw = empty_raw()
    raw["traces"] = [{"id": "t1", "userId": "u1"}, {"id": "t2", "userId": "u1"}]
    raw["generations"] = [
        {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-06T10:00:00Z"},  # первое окно
        {"name": "live_turn_voice", "traceId": "t2", "startTime": "2026-11-09T10:00:00Z"},  # второе окно
    ]
    store = FakeStore()
    app.backfill(store, lambda s, u: raw, date(2026, 11, 5), NOW, window_days=2)  # окна 05–06, 07–08, 09–10
    assert store.rows["2026-11-06"]["new_users"] == 1  # первый известный день
    assert store.rows["2026-11-09"]["new_users"] == 0  # во втором окне — уже не новый
    assert sum(row["new_users"] for row in store.rows.values()) == 1  # и только один раз за всю историю
    assert store.rows["2026-11-06"]["dau"] == 1 and store.rows["2026-11-09"]["dau"] == 1


# ---------- отчёт, кэш, вход ----------

def test_report_combines_snapshots_with_preliminary_today(monkeypatch):
    # Текущие сутки считаются из сырых источников и в daily_metrics не пишутся; их total_users —
    # накопленный итог последнего снимка до сегодня плюс предварительные new_users дня. Прошлые
    # сутки — только неизменяемые снимки, поля дня — прежние семь.
    store = FakeStore([snapshot_row("2026-11-10", dau=3, new_users=2, total_users=20)])
    calls = []

    def collect(since, until):
        calls.append((since, until))
        raw = empty_raw()
        raw["message_rows"] = [("2026-11-11", "u1", 4)]
        raw["first_message"] = {"u1": "2026-11-11"}
        return raw

    monkeypatch.setattr(app, "PgSnapshotStore", lambda dsn: store)
    monkeypatch.setattr(app, "collect_raw", collect)
    # Первые live-turn дни за всю историю здесь не отличаются от окна дня: u1 новый по first_message.
    monkeypatch.setattr(app, "langfuse_first_turns", lambda *args: {})
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setenv("DASHBOARD_DATABASE_URL", "postgres://dashboard")
    report = app.compute_report(NOW)
    assert report["period"] == {"from": "2026-11-05", "to": "2026-11-11", "timezone": "Europe/Moscow"}
    assert calls == [(datetime(2026, 11, 10, 21, tzinfo=UTC), datetime(2026, 11, 11, 21, tzinfo=UTC))]  # только сегодня
    today = report["days"][-1]
    assert today["date"] == "2026-11-11" and today["dau"] == 1 and today["new_users"] == 1
    assert today["total_users"] == 21  # 20 по снимкам + 1 предварительно новый сегодня
    assert set(today) == {"date", "dau", "daily_active_account", "new_users", "total_users",
                          "llm_requests", "tool_requests"}
    assert report["days"][-2]["dau"] == 3  # вчера — из снимка
    assert "2026-11-11" not in store.rows  # предварительный день снимком не закрывается
    assert store.rows["2026-11-10"] == snapshot_row("2026-11-10", dau=3, new_users=2, total_users=20)


def test_report_today_without_activity_keeps_total_from_snapshots(monkeypatch):
    # Пустые сырые данные текущих суток — не нули вместо итога: total_users повторяет последний снимок.
    store = FakeStore([snapshot_row("2026-11-09", new_users=5, total_users=42)])
    monkeypatch.setattr(app, "PgSnapshotStore", lambda dsn: store)
    monkeypatch.setattr(app, "collect_raw", lambda since, until: empty_raw())
    monkeypatch.setattr(app, "langfuse_first_turns", lambda *args: {})
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setenv("DASHBOARD_DATABASE_URL", "postgres://dashboard")
    report = app.compute_report(NOW)
    assert report["days"][-1]["total_users"] == 42
    assert report["days"][-1]["dau"] == 0


def test_report_today_merges_db_and_langfuse(monkeypatch):
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # предварительные текущие сутки считаются по тому же объединению, что и снимок: аккаунт, которого база
    # сегодня не сохранила, виден по трейсингу, а аккаунт из обоих источников не задваивается.
    store = FakeStore([snapshot_row("2026-11-10", dau=1, new_users=1, total_users=1)])

    def collect(since, until):
        raw = empty_raw()
        raw["message_rows"] = [("2026-11-11", "u1", 4)]  # u1 есть в базе
        raw["first_message"] = {"u1": "2026-11-11"}
        raw["traces"] = [{"id": "t1", "userId": "u1"}, {"id": "t2", "userId": "u2"}]
        raw["generations"] = [
            {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-11T08:00:00Z"},  # тот же u1
            {"name": "live_turn_text", "traceId": "t2", "startTime": "2026-11-11T09:00:00Z"},  # u2 — только трейсинг
        ]
        return raw

    monkeypatch.setattr(app, "PgSnapshotStore", lambda dsn: store)
    monkeypatch.setattr(app, "collect_raw", collect)
    # История live-turn тоже начинается сегодня: оба аккаунта действительно новые.
    monkeypatch.setattr(app, "langfuse_first_turns", lambda *args: {"u1": "2026-11-11", "u2": "2026-11-11"})
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setenv("DASHBOARD_DATABASE_URL", "postgres://dashboard")
    report = app.compute_report(NOW)
    today = report["days"][-1]
    assert today["date"] == "2026-11-11"
    assert today["dau"] == 2  # u1 (база + трейсинг, без двойного счёта) + u2 (только трейсинг)
    assert today["new_users"] == 2
    assert today["total_users"] == 3
    assert "2026-11-11" not in store.rows  # предварительный день снимком не закрывается

def test_langfuse_first_turns_fold_history_page_by_page(monkeypatch):
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # первые live-turn дни за всю историю конкурса сворачиваются постранично (страницы запрашиваются и
    # забываются по одной, вся история в память не собирается), observations — с фильтром name на стороне
    # API по проходу на имя; test/internal и трассы без userId отброшены.
    requests = []

    def fake_get(host, public_key, secret_key, path, params):
        requests.append((path, params.get("type"), params.get("name"), params["page"]))
        if path == "/api/public/traces":
            data = {
                1: [{"id": "t1", "userId": "u1"}, {"id": "t2", "userId": "u2"}],
                2: [{"id": "t3", "userId": "tester"}, {"id": "t4"}],  # t4 — трасса без userId
            }[params["page"]]
            return {"data": data, "meta": {"totalPages": 2}}
        observations = {
            "live_turn_voice": {
                1: [{"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-05T10:00:00Z"},
                    {"name": "live_turn_voice", "traceId": "t3", "startTime": "2026-11-06T10:00:00Z"}],  # tester
                2: [{"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-07T10:00:00Z"},
                    {"name": "live_turn_voice", "traceId": "t4", "startTime": "2026-11-07T11:00:00Z"}],  # без userId
            },
            "live_turn_text": {
                1: [{"name": "live_turn_text", "traceId": "t2", "startTime": "2026-11-09T10:00:00Z"}],
                2: [],
            },
        }[params["name"]]
        return {"data": observations[params["page"]], "meta": {"totalPages": 2}}

    monkeypatch.setattr(app, "_langfuse_get", fake_get)
    since, until = datetime(2026, 11, 4, 21, tzinfo=UTC), datetime(2026, 11, 11, 21, tzinfo=UTC)
    first = app.langfuse_first_turns("http://lf", "pk", "sk", since, until, {"tester"})
    assert first == {"u1": "2026-11-05", "u2": "2026-11-09"}  # min по всем страницам истории
    traces = [r for r in requests if r[0] == "/api/public/traces"]
    observations = [r for r in requests if r[0] == "/api/public/observations"]
    assert [r[3] for r in traces] == [1, 2]  # обе страницы трасс
    assert sorted((r[2], r[3]) for r in observations) == [
        ("live_turn_text", 1), ("live_turn_text", 2), ("live_turn_voice", 1), ("live_turn_voice", 2)]
    assert all(r[1] == "GENERATION" for r in observations)  # только live-turn имена, фильтр на стороне API


def test_report_today_langfuse_only_user_from_yesterday_is_not_new(monkeypatch):
    # openspec/changes/update-sber500-dashboard-metrics, «Сообщения восстанавливаются из трейсинга»:
    # первый известный день текущих суток — по всей истории конкурса, а не по окну дня: аккаунт,
    # известный только по трейсингу и говоривший вчера, сегодня НЕ новый и total_users не раздувает;
    # впервые говорящий сегодня — новый.
    store = FakeStore([snapshot_row("2026-11-10", dau=1, new_users=1, total_users=1)])

    def collect(since, until):  # сырые данные только текущих суток, как в бою
        assert (since, until) == (datetime(2026, 11, 10, 21, tzinfo=UTC), datetime(2026, 11, 11, 21, tzinfo=UTC))
        raw = empty_raw()
        raw["traces"] = [{"id": "t1", "userId": "u1"}, {"id": "t2", "userId": "u2"}]
        raw["generations"] = [
            {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-11T08:00:00Z"},  # u1 снова
            {"name": "live_turn_text", "traceId": "t2", "startTime": "2026-11-11T09:00:00Z"},  # u2 впервые
        ]
        return raw

    def fake_get(host, public_key, secret_key, path, params):
        if path == "/api/public/traces":
            assert params["fromTimestamp"] == "2026-11-04T21:00:00Z"  # история с начала конкурса, не с полуночи
            return {"data": [{"id": "t0", "userId": "u1"}, {"id": "t1", "userId": "u1"}, {"id": "t2", "userId": "u2"}],
                    "meta": {"totalPages": 1}}
        observations = {
            "live_turn_voice": [
                {"name": "live_turn_voice", "traceId": "t0", "startTime": "2026-11-10T10:00:00Z"},  # u1 вчера
                {"name": "live_turn_voice", "traceId": "t1", "startTime": "2026-11-11T08:00:00Z"},
            ],
            "live_turn_text": [{"name": "live_turn_text", "traceId": "t2", "startTime": "2026-11-11T09:00:00Z"}],
        }
        return {"data": observations[params["name"]], "meta": {"totalPages": 1}}

    monkeypatch.setattr(app, "PgSnapshotStore", lambda dsn: store)
    monkeypatch.setattr(app, "collect_raw", collect)
    monkeypatch.setattr(app, "_langfuse_get", fake_get)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
    monkeypatch.setenv("DASHBOARD_DATABASE_URL", "postgres://dashboard")
    report = app.compute_report(NOW)
    today = report["days"][-1]
    assert today["date"] == "2026-11-11"
    assert today["dau"] == 2  # u1 и u2 активны сегодня
    assert today["new_users"] == 1  # но новый только u2: у u1 есть трасса t0 вчера
    assert today["total_users"] == 2  # 1 по снимкам + 1 действительно новый, без раздувания
    assert "2026-11-11" not in store.rows

def test_report_has_six_new_fields_and_no_old_ones():
    # openspec/changes/update-sber500-dashboard-metrics, «JSON»: в каждом дне date, dau, llm_requests,
    # tool_requests, total_users, new_users, daily_active_account; старых полей нет.
    days = [date(2026, 11, 9), date(2026, 11, 10)]
    snapshots = {"2026-11-09": snapshot_row("2026-11-09", dau=4, total_users=12)}
    report = app.build_report(days, snapshots, NOW)
    assert report["period"] == {"from": "2026-11-09", "to": "2026-11-10", "timezone": "Europe/Moscow"}
    for day in report["days"]:
        assert set(day) == {"date", "dau", "daily_active_account", "new_users", "total_users",
                            "llm_requests", "tool_requests"}
        assert "active_users" not in day and "llm_calls" not in day and "users_total" not in day
    assert report["days"][1]["dau"] == 0 and report["days"][1]["total_users"] == 12  # день без снимка: итог накануне
    assert set(report["definitions"]) == {"dau", "daily_active_account", "new_users", "total_users",
                                          "llm_requests", "tool_requests"}


def test_page_labels_period_and_marks_today_preliminary():
    # Подписи периода: весь конкурс с 2026-11-05 по текущие сутки, суммы «за период», текущие сутки
    # явно помечены предварительными (звёздочка в таблице и на графиках, пометка в шапке).
    snapshots = {"2026-11-10": snapshot_row("2026-11-10", dau=3, new_users=2, total_users=42)}
    report = app.build_report(app.period_days(NOW), snapshots, NOW)
    assert report["period"] == {"from": "2026-11-05", "to": "2026-11-11", "timezone": "Europe/Moscow"}
    page = app.render_page(report)
    assert "05.11–11.11.2026" in page
    assert "Новых за период" in page and "Вызовов LLM за период" in page and "Tool calls — Память, за период" in page
    assert "за 7 дней" not in page
    assert "предварительные данные" in page
    assert "11.11.2026*" in page  # строка текущих суток в таблице
    assert ">11.11*<" in page  # подпись текущих суток на графиках
    assert "10.11.2026<" in page  # прошедшие сутки без пометки


def test_page_shows_six_metrics_and_since_dates(monkeypatch):
    # openspec/changes/update-sber500-dashboard-metrics, «Страница»: шесть метрик с новыми названиями,
    # определения, дни начала точного учёта llm_requests/tool_requests.
    monkeypatch.setenv("LLM_REQUESTS_SINCE", "2026-10-20")
    monkeypatch.setenv("TOOL_REQUESTS_SINCE", "2026-11-17")
    days = [date(2026, 11, 9), date(2026, 11, 10)]
    snapshots = {"2026-11-10": snapshot_row("2026-11-10", dau=4, new_users=2, total_users=71,
                                            llm_requests=1778, tool_requests=33)}
    page = app.render_page(app.build_report(days, snapshots, datetime(2026, 11, 11, 6, 5, tzinfo=UTC)))
    for title in ("DAU", "Активные аккаунты", "Новые пользователи", "Пользователи, всего", "Вызовы LLM", "Tool calls — Память"):
        assert title in page
    assert "1778" in page and "71" in page and "33" in page
    assert "2026-10-20" in page and "2026-11-17" in page  # дни начала точного учёта
    assert "09.11–10.11.2026" in page
    assert "users_total" not in page and "llm_calls" not in page and "active_users" not in page


def test_cache_recomputes_once_per_hour_and_on_a_new_day():
    # openspec/changes/update-sber500-dashboard-metrics, «Повторные открытия»: хранилище снимков
    # запрашивается не чаще раза в час.
    calls = []
    clock = [0.0]
    now = [datetime(2026, 11, 11, 9, tzinfo=UTC)]

    def compute(at):
        calls.append(at)
        return app.build_report(app.period_days(at), {}, at)

    cache = app.ReportCache(compute, ttl=3600, clock=lambda: clock[0], now=lambda: now[0])
    cache.get()
    clock[0] = 3599
    cache.get()
    assert len(calls) == 1
    clock[0] = 3601
    cache.get()
    assert len(calls) == 2
    now[0] = datetime(2026, 11, 12, 9, tzinfo=UTC)  # новые сутки — сразу пересчёт
    cache.get()
    assert len(calls) == 3


def test_cache_keeps_last_good_report_when_store_fails():
    # openspec/changes/update-sber500-dashboard-metrics, «Источник недоступен»: при сбое чтения хранилища
    # отдаётся прошлый результат, а без прошлого — исключение (HTTP-слой ответит 503).
    clock = [0.0]
    state = {"fail": False}

    def compute(at):
        if state["fail"]:
            raise RuntimeError("база недоступна")
        return app.build_report(app.period_days(at), {}, at)

    now = datetime(2026, 11, 11, 9, tzinfo=UTC)
    cache = app.ReportCache(compute, ttl=10, clock=lambda: clock[0], now=lambda: now)
    good = cache.get()
    state["fail"], clock[0] = True, 100
    assert cache.get() is good
    cold = app.ReportCache(compute, ttl=10, clock=lambda: clock[0], now=lambda: now)
    try:
        cold.get()
    except RuntimeError:
        pass
    else:
        raise AssertionError("холодный старт без хранилища должен падать (HTTP-слой отвечает 503)")


def test_credentials():
    assert app.credentials_ok(basic("sber500", "secret"), "sber500", "secret")
    assert not app.credentials_ok(basic("sber500", "wrong"), "sber500", "secret")
    assert not app.credentials_ok(basic("other", "secret"), "sber500", "secret")
    assert not app.credentials_ok(None, "sber500", "secret")
    assert not app.credentials_ok("Basic !!!", "sber500", "secret")
    assert not app.credentials_ok(basic("sber500", ""), "sber500", "")  # без пароля не пускаем никого


def test_failed_logins_block_after_limit_until_next_minute():
    clock = [120.0]
    failed = app.FailedLogins(limit=3, clock=lambda: clock[0])
    for _ in range(3):
        assert not failed.blocked("1.2.3.4")
        failed.fail("1.2.3.4")
    assert failed.blocked("1.2.3.4")
    assert not failed.blocked("5.6.7.8")
    clock[0] = 180.0
    assert not failed.blocked("1.2.3.4")


def test_main_fails_fast_without_langfuse_keys(monkeypatch):
    # openspec/changes/update-sber500-dashboard-metrics, «Вход и нагрузка»/задача 1.3: без ключей Langfuse
    # сервис не стартует с понятной ошибкой, как без DASHBOARD_PASSWORD или APP_DATABASE_URL.
    monkeypatch.setattr(app, "PASSWORD", "secret")
    monkeypatch.setattr(sys, "argv", ["app.py"])
    for name in ("DIALOG_DATABASE_URL", "APP_DATABASE_URL", "DASHBOARD_DATABASE_URL"):
        monkeypatch.setenv(name, "postgres://example")
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    try:
        app.main()
    except SystemExit as error:
        assert "LANGFUSE_PUBLIC_KEY" in str(error)
    else:
        raise AssertionError("без LANGFUSE_PUBLIC_KEY сервис не должен стартовать")


def test_report_uses_cognee_recovery_as_tool_floor():
    days = [date(2026, 11, 5), date(2026, 11, 6)]
    snapshots = {
        "2026-11-05": snapshot_row("2026-11-05", tool_requests=0),
        "2026-11-06": snapshot_row("2026-11-06", tool_requests=7),
    }
    report = app.build_report(days, snapshots, NOW, {"2026-11-05": 13, "2026-11-06": 4})
    assert report["days"][0]["tool_requests"] == 13
    assert report["days"][1]["tool_requests"] == 7
    assert snapshots["2026-11-05"]["tool_requests"] == 0


# ---------- metrics API (openspec/changes/add-sber500-metrics-api) ----------

TODAY = date(2026, 11, 11)


def test_metrics_api_range_validation():
    # openspec/changes/add-sber500-metrics-api, «Параметры и ошибки»: обе даты обязательны, формат
    # строгий, from ≤ to, не больше 90 дней включительно, date_to — не в будущем.
    days, error = app.parse_metrics_range({"date_from": ["2026-11-01"], "date_to": ["2026-11-05"]}, TODAY)
    assert error is None and days == [date(2026, 11, 1), date(2026, 11, 2), date(2026, 11, 3),
                                      date(2026, 11, 4), date(2026, 11, 5)]
    for params, text in (
        ({"date_from": ["2026-11-01"]}, "обязательные"),
        ({"date_from": ["2026-11-01"], "date_to": ["01.11.2026"]}, "YYYY-MM-DD"),
        ({"date_from": ["20261101"], "date_to": ["2026-11-05"]}, "YYYY-MM-DD"),
        ({"date_from": ["2026-11-10"], "date_to": ["2026-11-05"]}, "позже"),
        ({"date_from": ["2026-08-01"], "date_to": ["2026-11-10"]}, "90 дней"),
        ({"date_from": ["2026-11-05"], "date_to": ["2026-11-12"]}, "позже текущих суток"),
    ):
        days, error = app.parse_metrics_range(params, TODAY)
        assert days is None and text in error
    days, error = app.parse_metrics_range({"date_from": ["2026-11-01"], "date_to": ["2026-11-05", "2026-11-06"]}, TODAY)
    assert error is None and days[-1] == date(2026, 11, 5)  # повтор параметра допустим: берётся первое значение
    days, error = app.parse_metrics_range({"date_from": ["2026-08-13"], "date_to": ["2026-11-10"]}, TODAY)
    assert error is None and len(days) == 90  # ровно 90 дней включительно — граница допустима


def test_metrics_api_payload_shape_and_totals_chain():
    # openspec/changes/add-sber500-metrics-api, «Ответ»: поля строго как в ТЗ, числа целые, нули за день
    # без снимка, total_users без снимка повторяет последний известный итог, is_final только у прошлого.
    days = [date(2026, 11, 9), date(2026, 11, 10), date(2026, 11, 11)]
    snapshots = {
        "2026-11-09": snapshot_row("2026-11-09", dau=3, new_users=2, total_users=10, llm_requests=5, tool_requests=1),
        "2026-11-10": snapshot_row("2026-11-10", dau=4, new_users=1, total_users=11, llm_requests=6, tool_requests=2),
    }
    payload = app.build_metrics_payload(days, snapshots, {"2026-11-09": 7}, 4, NOW, TODAY)
    assert payload["startup_id"] == "ryadom"
    assert payload["timezone"] == "Europe/Moscow"
    assert payload["generated_at"] == "2026-11-11T12:00:00+03:00"
    assert payload["data"] == [
        {"date": "2026-11-09", "dau": 3, "llm_requests": 5, "tool_requests": 7, "total_users": 10,
         "new_users": 2, "is_final": True},
        {"date": "2026-11-10", "dau": 4, "llm_requests": 6, "tool_requests": 2, "total_users": 11,
         "new_users": 1, "is_final": True},
        {"date": "2026-11-11", "dau": 0, "llm_requests": 0, "tool_requests": 0, "total_users": 11,
         "new_users": 0, "is_final": False},
    ]
    assert list(payload["data"][0]) == ["date", "dau", "llm_requests", "tool_requests", "total_users", "new_users",
                                        "is_final"]


def test_metrics_api_total_start_keeps_cumulative_total():
    # openspec/changes/add-sber500-metrics-api, «Ответ»: запрос куска истории не обнуляет накопленный
    # итог — на первый день диапазона подкладывается total_users последнего снимка строго раньше него.
    days = [date(2026, 11, 10), date(2026, 11, 11)]
    snapshots = {"2026-11-10": snapshot_row("2026-11-10", total_users=11)}
    payload = app.build_metrics_payload(days, snapshots, {}, 11, NOW, TODAY)
    assert payload["data"][0]["total_users"] == 11  # из снимка дня
    snapshots = {}
    payload = app.build_metrics_payload(days, snapshots, {}, 11, NOW, TODAY)
    assert payload["data"][0]["total_users"] == 11  # из итога раньше диапазона
    assert payload["data"][1]["total_users"] == 11  # без снимка повторяет итог, а не падает к нулю


def test_metrics_api_combines_snapshots_and_preliminary_today(monkeypatch):
    # openspec/changes/add-sber500-metrics-api, «Источники»: закрытые дни — из неизменяемых снимков,
    # текущие сутки — предварительный расчёт из сырых источников, is_final=false.
    store = FakeStore(rows=[
        snapshot_row("2026-11-09", dau=3, new_users=2, total_users=10, llm_requests=5, tool_requests=1),
        snapshot_row("2026-11-10", dau=4, new_users=1, total_users=11, llm_requests=6, tool_requests=2),
    ])
    monkeypatch.setattr(app, "PgSnapshotStore", lambda dsn: store)
    monkeypatch.setenv("DASHBOARD_DATABASE_URL", "postgres://example")
    monkeypatch.setattr(app, "collect_raw", lambda since, until: empty_raw())
    monkeypatch.setattr(app, "_langfuse_config", lambda: ("http://langfuse", "pk", "sk"))
    monkeypatch.setattr(app, "_langfuse_fold", lambda *args: args[-1])  # свёртка без данных: аккумулятор как есть

    payload = app.compute_metrics_api(date(2026, 11, 9), date(2026, 11, 11), NOW)

    assert payload["data"][0]["dau"] == 3 and payload["data"][0]["is_final"] is True
    assert payload["data"][1]["tool_requests"] == 2
    today_row = payload["data"][2]
    assert today_row["date"] == "2026-11-11" and today_row["is_final"] is False
    assert today_row["dau"] == 0 and today_row["total_users"] == 11  # итог вчерашнего снимка + 0 новых


def test_metrics_api_cache_recomputes_range_once_per_ttl():
    # openspec/changes/add-sber500-metrics-api, «Нагрузка»: закрытые дни неизменны — пересчёт диапазона
    # не чаще раза в 15 минут; протухшие ключи выбрасываются.
    calls = []
    clock = [0.0]

    def compute(day_from, day_to, now):
        calls.append((day_from, day_to))
        return {"ok": True}

    cache = app.RangeCache(compute, ttl=900, clock=lambda: clock[0])
    now = datetime(2026, 11, 11, 9, tzinfo=UTC)
    assert cache.get(date(2026, 11, 1), date(2026, 11, 7), now) == {"ok": True}
    clock[0] = 899
    cache.get(date(2026, 11, 1), date(2026, 11, 7), now)
    assert len(calls) == 1
    clock[0] = 901
    cache.get(date(2026, 11, 1), date(2026, 11, 7), now)
    assert len(calls) == 2
    clock[0] = 2000
    cache.get(date(2026, 11, 8), date(2026, 11, 9), now)  # протухший ключ выброшен, память не растёт
    assert len(calls) == 3


def test_metrics_api_token():
    # openspec/changes/add-sber500-metrics-api, «Доступ»: Bearer, постоянное время, без токена — никого.
    assert app.token_ok("Bearer abcdef", "abcdef")
    assert not app.token_ok("Bearer abcdef", "abcdefg")
    assert not app.token_ok("Basic abcdef", "abcdef")
    assert not app.token_ok(None, "abcdef")
    assert not app.token_ok("Bearer abcdef", "")


def test_metrics_api_rate_limit_allows_up_to_limit_per_minute():
    # openspec/changes/add-sber500-metrics-api, «Доступ»: лимит не ниже 10 запросов в минуту на IP.
    clock = [60.0]
    rate = app.RateLimit(limit=3, clock=lambda: clock[0])
    for _ in range(3):
        assert rate.allowed("1.2.3.4")
    assert not rate.allowed("1.2.3.4")
    assert rate.allowed("5.6.7.8")
    clock[0] = 120.0
    assert rate.allowed("1.2.3.4")


def test_today_cache_serves_warm_value_without_recomputing():
    # openspec/specs/sber500-dashboard, «Нагрузка»: тяжёлый расчёт текущих суток обновляет фон,
    # запрос получает готовое значение того же дня.
    calls = []

    def compute(now, first_day):
        calls.append(first_day)
        return {"dau": len(calls)}

    cache = app.TodayCache(compute)
    now = datetime(2026, 11, 11, 9, tzinfo=UTC)
    cache.refresh(now)
    assert cache.get(now, date(2026, 11, 5)) == {"dau": 1}
    assert len(calls) == 1
    cache.get(datetime(2026, 11, 12, 9, tzinfo=UTC), date(2026, 11, 5))  # сутки сменились — считаем заново
    assert len(calls) == 2


def test_today_cache_keeps_previous_value_when_refresh_fails():
    state = {"fail": False}

    def compute(now, first_day):
        if state["fail"]:
            raise RuntimeError("источник недоступен")
        return {"dau": 5}

    cache = app.TodayCache(compute)
    now = datetime(2026, 11, 11, 9, tzinfo=UTC)
    cache.refresh(now)
    state["fail"] = True
    try:
        cache.refresh(now)
    except RuntimeError:
        pass
    assert cache.get(now, date(2026, 11, 5)) == {"dau": 5}


def test_token_ok_accepts_case_insensitive_scheme():
    assert app.token_ok("Bearer secret", "secret")
    assert app.token_ok("bearer secret", "secret")
    assert not app.token_ok("secret", "secret")
    assert not app.token_ok("Bearer wrong", "secret")
