"""REQ-OBS-06, openspec/changes/add-daily-metrics-retention.

«Ежедневная выгрузка и retention для Sber500» и «Когорты регистрации в выгрузке Sber500».
"""

import base64
import http.client
import json
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from threading import Thread

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app
import daily_metrics as export


def test_retention_uses_registration_date_and_distinct_active_users():
    target = date(2026, 11, 23)
    cohorts = {
        "d1": target - timedelta(days=1),
        "d3": target - timedelta(days=3),
        "d7": target - timedelta(days=7),
        "d14": target - timedelta(days=14),
        "same-day": target,
        "d8": target - timedelta(days=8),
        "inactive": target - timedelta(days=7),
    }
    active = ["d1", "d3", "d7", "d7", "d14", "same-day", "d8", "unknown"]
    assert export.retention_counts(target, active, cohorts) == {
        "retained_d1": 1, "retained_d3": 1, "retained_d7": 1, "retained_d14": 1,
    }


def test_export_backfills_past_rows_and_replaces_provisional(monkeypatch):
    first = date(2026, 11, 9)
    last = date(2026, 11, 23)
    service = export.DailyMetrics("", "", first, app.MSK, "ryadom", lambda start, end: (set(), {}))
    activity = {}
    maturing = date(2026, 11, 16)

    def save(day, final):
        activity[day] = {**export.ZERO_ACTIVITY, "is_final": final}
        if day == last:
            activity[day]["retained_d7"] = 2
            activity[day]["retained_d14"] = 1

    class Existing:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def execute(self, _):
            return [(day,) for day, row in activity.items() if row["is_final"]]

    monkeypatch.setattr(service, "_connect", Existing)
    monkeypatch.setattr(service, "_save_activity", save)
    monkeypatch.setattr(service, "_load_activity", lambda *_: activity)
    monkeypatch.setattr(service, "_load_registrations", lambda *_: {None: 10, first: 1, maturing: 3})
    before = datetime(2026, 11, 23, 20, 59, 59, tzinfo=UTC)
    service.refresh(before, 0, 15)
    rows = service.report(first, last, before)["data"]
    assert len(rows) == 15
    assert rows[7]["is_final"] is True
    assert rows[7]["new_users"] == 3
    assert rows[7]["retained_d7"] is None
    assert rows[-1]["is_final"] is False
    assert all(rows[-1][field] is None for field in export.RETENTION_FIELDS.values())

    midnight = before + timedelta(seconds=1)
    with pytest.raises(LookupError):
        service.report(first, last, midnight)
    closed = midnight + timedelta(minutes=15)
    service.refresh(closed, 0, 15)
    rows = service.report(first, last, closed)["data"]
    assert rows[0]["retained_d14"] == 1
    assert rows[7]["retained_d7"] == 2
    assert rows[7]["retained_d3"] == 0
    assert rows[7]["retained_d14"] is None
    assert rows[-1]["new_users"] == 0
    assert rows[-1]["total_users"] == 14
    assert rows[-1]["is_final"] is True
    assert service.report(maturing, maturing, closed)["data"][0]["retained_d7"] == 2


@pytest.mark.parametrize("query", [
    "",
    "date_from=2026-02-29&date_to=2026-03-01",
    "date_from=2026-2-28&date_to=2026-03-01",
    "date_from=20260228&date_to=2026-03-01",
    "date_from=2026-11-24&date_to=2026-11-23",
    "date_from=2026-01-01&date_to=2026-04-01",
    "date_from=2026-01-01&date_from=2026-01-02&date_to=2026-03-31",
])
def test_invalid_date_ranges(query):
    with pytest.raises(ValueError):
        export.date_range(query)


def test_http_protects_export_and_returns_json(monkeypatch):
    token = "synthetic-dashboard-token-for-tests"
    monkeypatch.setattr(app, "METRICS_TOKEN", token)
    monkeypatch.setattr(app, "METRICS_LIMIT", export.MetricsRateLimit(limit=10, clock=lambda: 0))
    service = export.DailyMetrics("", "", date(2026, 11, 5), app.MSK, "ryadom", lambda *_: None)
    monkeypatch.setattr(service, "_load_activity", lambda *_: {})
    monkeypatch.setattr(service, "_load_registrations", lambda *_: {})
    with app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler) as server:
        server.daily_metrics = service
        thread = Thread(target=server.serve_forever)
        thread.start()
        connection = http.client.HTTPConnection(*server.server_address, timeout=2)

        def get(path, authorization=None):
            headers = {"Authorization": authorization} if authorization else {}
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            assert response.headers["Content-Type"].startswith("application/json")
            return response.status, json.loads(response.read())

        try:
            query = export.PATH + "?date_from=2026-01-01&date_to=2026-03-31"
            for authorization in (None, "Basic " + token, "Bearer incorrect"):
                status, payload = get(query, authorization)
                assert status == 401
                assert "error" in payload
            auth = "Bearer " + token
            assert get(export.PATH, auth)[0] == 400
            status, payload = get(query, auth)
            assert status == 200
            assert payload["startup_id"] == "ryadom"
            assert payload["timezone"] == "Europe/Moscow"
            assert len(payload["data"]) == 90
            assert set(payload["data"][0]) == {
                "date", "dau", "llm_requests", "tool_requests", "new_users", "total_users", "is_final",
                "retained_d1", "retained_d3", "retained_d7", "retained_d14",
            }
            for _ in range(8):
                assert get(query, auth)[0] == 200
            assert get(query, auth)[0] == 429
        finally:
            connection.close()
            server.shutdown()
            thread.join(timeout=2)


def test_export_activity_uses_same_dau_sources(monkeypatch):
    import psycopg

    class Source:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def execute(self, query):
            assert query == app.SQL_EXCLUDED_USERS
            return [("internal",)]

    monkeypatch.setenv("DIALOG_DATABASE_URL", "synthetic-agent-dsn")
    monkeypatch.setenv("APP_DATABASE_URL", "synthetic-app-dsn")
    monkeypatch.setattr(psycopg, "connect", lambda *_args, **_kwargs: Source())
    day = "2026-11-23"
    monkeypatch.setattr(app, "query_message_rows", lambda *_: [(day, "both", 2), (day, "db", 1), (day, "internal", 1)])
    stamp = day + "T08:00:00Z"
    turn = {"name": "live_turn_text", "traceId": "trace-both", "startTime": stamp}
    raw = {
        "generations": [turn, turn, {**turn, "traceId": "trace-only"}, {**turn, "traceId": "trace-test"}],
        "traces": [
            {"id": "trace-both", "userId": "both"},
            {"id": "trace-only", "userId": "trace-only"},
            {"id": "trace-test", "userId": "internal"},
        ],
        "tools": [{"name": "memory_search", "traceId": "trace-only", "startTime": stamp}],
    }
    monkeypatch.setattr(app, "_langfuse_config", lambda: ("synthetic-host", "synthetic-public", "synthetic-secret"))
    monkeypatch.setattr(app, "query_langfuse", lambda *_: raw)
    active, metrics = app.collect_export_activity(*app.utc_bounds([date.fromisoformat(day)]))
    assert active == {"both", "db", "trace-only"}
    legacy = app.metrics_by_day(
        [(day, "both", 2), (day, "db", 1), (day, "internal", 1)], {}, {"internal"}, {}, **raw,
    )[day]
    assert metrics == {field: legacy[field] for field in export.ACTIVITY_FIELDS}


def test_dashboard_renders_registration_cohorts_from_export(monkeypatch):
    """OpenSpec «Таблица удержания на дашборде Sber500»."""
    now = datetime(2026, 11, 24, 9, tzinfo=UTC)
    report = app.build_report(app.period_days(now), {}, now)
    monkeypatch.setattr(app.CACHE, "get", lambda: report)
    monkeypatch.setattr(app, "USER", "demo")
    monkeypatch.setattr(app, "PASSWORD", "synthetic")
    monkeypatch.setattr(app, "METRICS_TOKEN", "")

    class Export:
        def report(self, first, last, now):
            assert (first, last) == (date(2026, 11, 5), date(2026, 11, 24))
            return {"data": [{
                "date": "2026-11-16", "new_users": 3, "is_final": True,
                "retained_d1": 0, "retained_d3": 1, "retained_d7": 2, "retained_d14": None,
            }]}

    with app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler) as server:
        server.daily_metrics = Export()
        thread = Thread(target=server.serve_forever)
        thread.start()
        connection = http.client.HTTPConnection(*server.server_address, timeout=2)
        headers = {"Authorization": "Basic " + base64.b64encode(b"demo:synthetic").decode()}
        try:
            connection.request("GET", "/dashboard", headers=headers)
            response = connection.getresponse()
            assert response.status == 200
            page = response.read().decode()
            assert "Удержание по дате регистрации" in page
            assert 'datetime="2026-11-16">16.11.2026</time>' in page
            assert '<td>3</td><td>0</td><td>1</td><td>2</td><td class="muted">—</td>' in page

            connection.request("GET", "/dashboard/api", headers=headers)
            response = connection.getresponse()
            assert response.status == 200
            assert json.loads(response.read()) == report

            def unavailable(*_):
                raise LookupError

            server.daily_metrics.report = unavailable
            connection.request("GET", "/dashboard", headers=headers)
            response = connection.getresponse()
            assert response.status == 200
            page = response.read().decode()
            assert "Данные когорт ещё обновляются." in page
            assert "DAU — активные за сутки" in page
        finally:
            connection.close()
            server.shutdown()
            thread.join(timeout=2)
