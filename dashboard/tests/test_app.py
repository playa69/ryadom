"""Чистые функции дашборда: период, свёртка по суткам, нарастающий итог, кэш, вход."""

import base64
import sys
from datetime import UTC, date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app


def basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def test_period_is_last_seven_full_moscow_days():
    # 11.11 01:30 по Москве = 10.11 22:30 UTC: «вчера» по Москве — 10.11.
    days = app.period_days(datetime(2026, 11, 10, 22, 30, tzinfo=UTC))
    assert days[0] == date(2026, 11, 4) and days[-1] == date(2026, 11, 10) and len(days) == 7


def test_bounds_are_moscow_midnights_in_utc():
    since, until = app.utc_bounds([date(2026, 11, 4), date(2026, 11, 10)])
    assert since == datetime(2026, 11, 3, 21, tzinfo=UTC)
    assert until == datetime(2026, 11, 10, 21, tzinfo=UTC)


def test_langfuse_hours_fold_into_moscow_days():
    body = {"data": [
        {"time_dimension": "2026-11-04T20:00:00Z", "count_count": "2"},  # 04.11 23:00 МСК
        {"time_dimension": "2026-11-04T21:00:00Z", "count_count": "5"},  # 05.11 00:00 МСК
        {"time_dimension": "2026-11-05T10:00:00Z", "count_count": 3},
    ]}
    assert app.traces_by_day(body) == {"2026-11-04": 2, "2026-11-05": 8}


def test_users_total_is_a_running_sum_from_all_time():
    days = [date(2026, 11, 5), date(2026, 11, 6), date(2026, 11, 7)]
    became = {"2026-10-20": 4, "2026-11-01": 1, "2026-11-05": 2, "2026-11-07": 3}
    assert app.users_total_by_day(became, days) == {"2026-11-05": 7, "2026-11-06": 7, "2026-11-07": 10}


def test_report_fills_missing_days_with_zero():
    days = [date(2026, 11, 5), date(2026, 11, 6)]
    report = app.build_report(days, {"2026-11-06": 3}, {"2026-11-05": 1, "2026-11-06": 2}, {}, datetime(2026, 11, 7, tzinfo=UTC))
    assert report["days"] == [
        {"date": "2026-11-05", "active_users": 0, "llm_calls": 0, "users_total": 1},
        {"date": "2026-11-06", "active_users": 3, "llm_calls": 0, "users_total": 2},
    ]
    assert report["period"] == {"from": "2026-11-05", "to": "2026-11-06", "timezone": "Europe/Moscow"}


def test_cache_recomputes_once_per_hour_and_on_a_new_day():
    calls = []
    clock = [0.0]
    now = [datetime(2026, 11, 11, 9, tzinfo=UTC)]

    def compute(at):
        calls.append(at)
        return app.build_report(app.period_days(at), {}, {}, {}, at)

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


def test_cache_keeps_last_good_report_when_recompute_fails():
    clock = [0.0]
    state = {"fail": False}

    def compute(at):
        if state["fail"]:
            raise RuntimeError("база недоступна")
        return app.build_report(app.period_days(at), {}, {}, {}, at)

    now = datetime(2026, 11, 11, 9, tzinfo=UTC)
    cache = app.ReportCache(compute, ttl=10, clock=lambda: clock[0], now=lambda: now)
    good = cache.get()
    state["fail"], clock[0] = True, 100
    assert cache.get() is good


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


def test_page_renders_numbers_and_escapes_text():
    days = [date(2026, 11, 5), date(2026, 11, 6)]
    report = app.build_report(days, {"2026-11-05": 4}, {"2026-11-05": 71, "2026-11-06": 121}, {"2026-11-06": 1778},
                              datetime(2026, 11, 7, 6, 5, tzinfo=UTC))
    page = app.render_page(report)
    assert "1778" in page and "121" in page and "<svg" in page
    assert "05.11–06.11.2026" in page
