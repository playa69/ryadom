"""Выгрузка Sber500 (REQ-OBS-06). В собственной БД остаются только дневные агрегаты."""

import logging
import re
import time
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, date, datetime, timedelta, tzinfo
from threading import Event, Lock
from urllib.parse import parse_qs

log = logging.getLogger("dashboard")

PATH = "/api/v1/metrics/daily"
RETENTION_FIELDS = {offset: f"retained_d{offset}" for offset in (1, 3, 7, 14)}
MAX_RETENTION = timedelta(days=max(RETENTION_FIELDS))
ACTIVITY_FIELDS = ("dau", "llm_requests", "tool_requests")
STORED_FIELDS = ACTIVITY_FIELDS + tuple(RETENTION_FIELDS.values())
ZERO_ACTIVITY = dict.fromkeys(STORED_FIELDS, 0)
ONE_DAY = timedelta(days=1)

SQL_CREATE = """
CREATE TABLE IF NOT EXISTS daily_export_activity (
    day date PRIMARY KEY,
    is_final boolean NOT NULL,
    dau integer NOT NULL,
    llm_requests integer NOT NULL,
    tool_requests integer NOT NULL,
    retained_d1 integer NOT NULL,
    retained_d3 integer NOT NULL,
    retained_d7 integer NOT NULL,
    retained_d14 integer NOT NULL
)
"""

SQL_SAVE = """
INSERT INTO daily_export_activity (
    day, is_final, dau, llm_requests, tool_requests, retained_d1, retained_d3, retained_d7, retained_d14
) VALUES (
    %(day)s, %(is_final)s, %(dau)s, %(llm_requests)s, %(tool_requests)s,
    %(retained_d1)s, %(retained_d3)s, %(retained_d7)s, %(retained_d14)s
)
ON CONFLICT (day) DO UPDATE SET
    is_final = EXCLUDED.is_final, dau = EXCLUDED.dau,
    llm_requests = EXCLUDED.llm_requests, tool_requests = EXCLUDED.tool_requests,
    retained_d1 = EXCLUDED.retained_d1, retained_d3 = EXCLUDED.retained_d3,
    retained_d7 = EXCLUDED.retained_d7, retained_d14 = EXCLUDED.retained_d14
WHERE NOT daily_export_activity.is_final
"""

SQL_COHORTS = """
SELECT id::text, (created_at AT TIME ZONE 'Europe/Moscow')::date
FROM users
WHERE created_at >= %(since)s AND created_at < %(until)s
  AND coalesce(properties->>'traffic_type', 'real') NOT IN ('test', 'internal')
"""

SQL_REGISTRATIONS = """
SELECT CASE WHEN created_at >= %(since)s THEN (created_at AT TIME ZONE 'Europe/Moscow')::date END AS day,
       count(*)
FROM users
WHERE created_at < %(until)s
  AND coalesce(properties->>'traffic_type', 'real') NOT IN ('test', 'internal')
GROUP BY 1
"""


def date_range(query: str) -> tuple[date, date]:
    params = parse_qs(query, keep_blank_values=True, max_num_fields=20)
    days = []
    for key in ("date_from", "date_to"):
        values = params.get(key, [])
        if len(values) != 1 or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", values[0]):
            raise ValueError("Укажите date_from и date_to в формате YYYY-MM-DD")
        days.append(date.fromisoformat(values[0]))
    first, last = days
    if not 0 <= (last - first).days < 90:
        raise ValueError("Диапазон должен содержать от 1 до 90 суток")
    return first, last


def retention_counts(day: date, active: Iterable[str], cohorts: Mapping[str, date]) -> dict[str, int]:
    counts = dict.fromkeys(RETENTION_FIELDS.values(), 0)
    for user in set(active):
        registered = cohorts.get(user)
        if registered is not None:
            field = RETENTION_FIELDS.get((day - registered).days)
            if field:
                counts[field] += 1
    return counts


class MetricsRateLimit:
    def __init__(self, limit: int = 30, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.clock = clock
        self.lock = Lock()
        self.minute = -1
        self.counts: dict[str, int] = {}

    def allow(self, ip: str) -> bool:
        with self.lock:
            minute = int(self.clock() // 60)
            if minute != self.minute:
                self.minute, self.counts = minute, {}
            count = self.counts.get(ip, 0)
            if count >= self.limit:
                return False
            self.counts[ip] = count + 1
            return True


class DailyMetrics:
    def __init__(self, dashboard_dsn: str, app_dsn: str, activity_start: date, msk: tzinfo, startup_id: str,
                 collect_activity: Callable[[datetime, datetime], tuple[set[str], dict[str, int]]]):
        self.dashboard_dsn = dashboard_dsn
        self.app_dsn = app_dsn
        self.activity_start = activity_start
        self.msk = msk
        self.startup_id = startup_id
        self.collect_activity = collect_activity
        self.ready = Event()

    def _connect(self, *, app: bool = False):
        import psycopg

        options = "-c statement_timeout=2000"
        if app:
            options += " -c default_transaction_read_only=on"
        return psycopg.connect(self.app_dsn if app else self.dashboard_dsn, options=options, connect_timeout=2)

    def _midnight(self, day: date) -> datetime:
        return datetime.combine(day, datetime.min.time(), self.msk)

    def ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(SQL_CREATE)

    def _save_activity(self, day: date, final: bool) -> None:
        active, metrics = self.collect_activity(
            self._midnight(day).astimezone(UTC), self._midnight(day + ONE_DAY).astimezone(UTC),
        )
        counts = ZERO_ACTIVITY
        if final and active:
            with self._connect(app=True) as conn:
                cohorts = dict(conn.execute(SQL_COHORTS, {
                    "since": self._midnight(day - MAX_RETENTION),
                    "until": self._midnight(day),
                }))
            counts = retention_counts(day, active, cohorts)
        with self._connect() as conn:
            conn.execute(SQL_SAVE, {**counts, **metrics, "day": day, "is_final": final})

    def refresh(self, now: datetime, close_hour: int, close_minute: int) -> None:
        local = now.astimezone(self.msk)
        today = local.date()
        close_before = today if (local.hour, local.minute) >= (close_hour, close_minute) else today - ONE_DAY
        with self._connect() as conn:
            existing = {row[0] for row in conn.execute("SELECT day FROM daily_export_activity WHERE is_final")}
        for index in range((close_before - self.activity_start).days):
            day = self.activity_start + timedelta(days=index)
            if day not in existing:
                self._save_activity(day, final=True)
        if today >= self.activity_start:
            self._save_activity(today, final=False)

    def run_forever(self, refresh_seconds: int, close_hour: int, close_minute: int) -> None:
        while True:
            try:
                self.refresh(datetime.now(UTC), close_hour, close_minute)
                if not self.ready.is_set():
                    self.ready.set()
                    log.info("Агрегаты ежедневной выгрузки готовы")
            except Exception as error:
                # Тела ответов источников и DSN не должны попадать в журнал.
                log.error("Не удалось обновить агрегаты ежедневной выгрузки: %s", type(error).__name__)
            time.sleep(refresh_seconds)

    def _load_activity(self, first: date, last: date) -> dict[date, dict]:
        with self._connect() as conn:
            rows = conn.execute("""
                SELECT day, e.is_final, coalesce(s.dau, e.dau, 0),
                       coalesce(s.llm_requests, e.llm_requests, 0),
                       greatest(coalesce(s.tool_requests, e.tool_requests, 0), coalesce(r.tool_requests, 0)),
                       e.retained_d1, e.retained_d3, e.retained_d7, e.retained_d14
                FROM daily_export_activity e
                FULL JOIN daily_metrics s USING (day)
                FULL JOIN tool_call_recovery r USING (day)
                WHERE day BETWEEN %s AND %s
            """, (first, last))
            return {day: dict(zip(("is_final",) + STORED_FIELDS, values, strict=True)) for day, *values in rows}

    def _load_registrations(self, first: date, last: date) -> dict[date | None, int]:
        with self._connect(app=True) as conn:
            return dict(conn.execute(SQL_REGISTRATIONS, {
                "since": self._midnight(first),
                "until": self._midnight(last) + ONE_DAY,
            }))

    def report(self, first: date, last: date, now: datetime) -> dict:
        local = now.astimezone(self.msk)
        today = local.date()
        latest_activity = last + MAX_RETENTION if today - last > MAX_RETENTION else today
        activity = self._load_activity(first, latest_activity)
        registrations = self._load_registrations(first, min(last, today))
        total = registrations.get(None, 0)

        def for_day(day: date) -> dict:
            if self.activity_start <= day <= today:
                row = activity.get(day)
                if row is None or row["is_final"] != (day < today):
                    raise LookupError("Агрегаты ещё формируются")
                return row
            return activity.get(day, ZERO_ACTIVITY)

        data = []
        for index in range((last - first).days + 1):
            day = first + timedelta(days=index)
            new = registrations.get(day, 0)
            total += new
            day_activity = for_day(day)
            row = {
                "date": day.isoformat(),
                **{field: day_activity[field] for field in ACTIVITY_FIELDS},
                "total_users": total,
                "new_users": new,
                "is_final": day < today,
            }
            for offset, field in RETENTION_FIELDS.items():
                target_is_closed = (today - day).days > offset
                target = day + timedelta(days=offset)
                if target_is_closed and target >= self.activity_start:
                    row[field] = for_day(target)[field]
                else:
                    row[field] = 0 if target_is_closed else None
            data.append(row)
        return {
            "startup_id": self.startup_id,
            "timezone": "Europe/Moscow",
            "generated_at": local.isoformat(timespec="seconds"),
            "data": data,
        }
