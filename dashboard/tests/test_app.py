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
    monkeypatch.setenv("DASHBOARD_DATABASE_URL", "postgres://dashboard")
    report = app.compute_report(NOW)
    assert report["days"][-1]["total_users"] == 42
    assert report["days"][-1]["dau"] == 0

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
