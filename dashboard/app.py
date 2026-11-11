"""Дашборд метрик «Слышу Рядом» для Sber500: три числа по дням за последние 7 полных суток по Москве.

    GET /dashboard      — страница с графиками и таблицей (basic auth)
    GET /dashboard/api  — те же числа JSON-ом (basic auth)
    GET /healthz        — для проб, наружу не маршрутизируется

Метрики (определения команды от 11.11.2026):
- активные — люди, у которых больше 10 реплик за сутки (база агента);
- пользователи — аккаунты, у которых за всё время больше 3 реплик, нарастающим итогом (база агента);
- вызовы LLM — трассы Langfuse за сутки, все вызовы моделей агента.
Тестовые аккаунты не исключаются. Числа пересчитываются не чаще раза в час, запросы к странице базу и Langfuse не трогают.
Наружу уходят только суммы: ни текстов, ни идентификаторов людей сервис не отдаёт.
"""

import base64
import hmac
import html
import json
import logging
import os
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("dashboard")

MSK = timezone(timedelta(hours=3))  # в Москве нет перехода на летнее время с 2014 года
DAYS = 7
CACHE_SECONDS = 3600
FAILED_LOGINS_PER_MINUTE = 10
ACTIVE_THRESHOLD = 10  # «больше 10 реплик за сутки»
USER_REPLY = 4  # «больше 3 реплик»: человек становится пользователем на 4-й реплике

DEFINITIONS = {
    "active_users": "Активные (DAU): люди, у которых больше 10 реплик за сутки по Москве.",
    "llm_calls": "Вызовы LLM: все вызовы моделей агента за сутки (трассы Langfuse).",
    "users_total": "Пользователи: аккаунты, у которых за всё время больше 3 реплик, нарастающим итогом на конец суток.",
}


# ---------- период ----------

def period_days(now: datetime) -> list[date]:
    """Последние 7 полных московских суток: со вчерашнего дня назад."""
    yesterday = now.astimezone(MSK).date() - timedelta(days=1)
    return [yesterday - timedelta(days=DAYS - 1 - i) for i in range(DAYS)]


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
    if not text.endswith("Z") and "+" not in text[10:]:
        text += "Z"
    try:
        at = datetime.fromisoformat(text)
    except ValueError:
        return None
    return at.astimezone(MSK).date().isoformat()


# ---------- расчёт ----------

SQL_ACTIVE = """
SELECT to_char(day, 'YYYY-MM-DD') AS day, count(*) FILTER (WHERE n > %(threshold)s) AS active
FROM (
  SELECT (m.created_at::timestamptz AT TIME ZONE 'Europe/Moscow')::date AS day, d.user_id, count(*) AS n
  FROM messages m JOIN dialogs d ON d.id = m.dialog_id
  WHERE m.role = 'user' AND m.created_at::timestamptz >= %(since)s AND m.created_at::timestamptz < %(until)s
  GROUP BY 1, 2
) per_person
GROUP BY 1
"""

# День, когда у человека случилась 4-я реплика за всё время: с этого дня он «пользователь».
SQL_BECAME_USER = """
SELECT to_char((at AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS day, count(*) AS users
FROM (
  SELECT m.created_at::timestamptz AS at,
    row_number() OVER (PARTITION BY d.user_id ORDER BY m.created_at::timestamptz, m.id) AS rn
  FROM messages m JOIN dialogs d ON d.id = m.dialog_id
  WHERE m.role = 'user' AND m.created_at::timestamptz < %(until)s
) numbered
WHERE rn = %(reply)s
GROUP BY 1
"""


def users_total_by_day(became: dict[str, int], days: list[date]) -> dict[str, int]:
    """Нарастающий итог: все, кто стал пользователем до конца каждых суток."""
    first = days[0].isoformat()
    total = sum(n for day, n in became.items() if day < first)
    out = {}
    for d in days:
        total += became.get(d.isoformat(), 0)
        out[d.isoformat()] = total
    return out


def traces_by_day(body: dict) -> dict[str, int]:
    """Ответ API метрик Langfuse по часам → число трасс по московским суткам."""
    out: dict[str, int] = {}
    for row in body.get("data") or []:
        day = msk_day(row.get("time_dimension") or row.get("timeDimension") or "")
        if day:
            out[day] = out.get(day, 0) + int(float(row.get("count_count") or 0))
    return out


def query_database(dsn: str, since: datetime, until: datetime) -> tuple[dict[str, int], dict[str, int]]:
    import psycopg  # импорт здесь, чтобы тесты чистых функций не требовали драйвера

    # Сессия только на чтение: сервис ничего не пишет, даже по ошибке.
    with psycopg.connect(dsn, options="-c default_transaction_read_only=on", connect_timeout=10) as conn:
        active = {
            r[0]: int(r[1])
            for r in conn.execute(SQL_ACTIVE, {"since": since, "until": until, "threshold": ACTIVE_THRESHOLD})
        }
        became = {r[0]: int(r[1]) for r in conn.execute(SQL_BECAME_USER, {"until": until, "reply": USER_REPLY})}
    return active, became


def query_langfuse(host: str, public_key: str, secret_key: str, since: datetime, until: datetime) -> dict[str, int]:
    query = {
        "view": "traces",
        "dimensions": [],
        "metrics": [{"measure": "count", "aggregation": "count"}],
        "filters": [],
        "timeDimension": {"granularity": "hour"},
        "fromTimestamp": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "toTimestamp": until.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config": {"row_limit": 1000},
    }
    url = host.rstrip("/") + "/api/public/metrics?" + urllib.parse.urlencode({"query": json.dumps(query)})
    auth = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
    request = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return traces_by_day(json.loads(response.read()))


def build_report(days: list[date], active: dict, users: dict, llm: dict, computed_at: datetime) -> dict:
    return {
        "period": {"from": days[0].isoformat(), "to": days[-1].isoformat(), "timezone": "Europe/Moscow"},
        "updated_at": computed_at.astimezone(MSK).isoformat(timespec="minutes"),
        "definitions": DEFINITIONS,
        "days": [
            {
                "date": d.isoformat(),
                "active_users": active.get(d.isoformat(), 0),
                "llm_calls": llm.get(d.isoformat(), 0),
                "users_total": users.get(d.isoformat(), 0),
            }
            for d in days
        ],
    }


def compute_report(now: datetime) -> dict:
    days = period_days(now)
    since, until = utc_bounds(days)
    started = time.monotonic()
    active, became = query_database(os.environ["DIALOG_DATABASE_URL"], since, until)
    llm = query_langfuse(
        os.environ.get("LANGFUSE_HOST", "http://langfuse-web.infra.svc.cluster.local:3000"),
        os.environ["LANGFUSE_PUBLIC_KEY"],
        os.environ["LANGFUSE_SECRET_KEY"],
        since,
        until,
    )
    log.info("пересчитано за %s–%s, %.1f с", days[0], days[-1], time.monotonic() - started)
    return build_report(days, active, users_total_by_day(became, days), llm, now)


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
            except Exception:  # любой сбой базы или Langfuse: отдаём прошлое
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
        label = d["date"][8:10] + "." + d["date"][5:7]
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
    rows = "".join(
        f'<tr><td>{d["date"][8:10]}.{d["date"][5:7]}.{d["date"][:4]}</td><td>{d["active_users"]}</td>'
        f'<td>{d["llm_calls"]}</td><td>{d["users_total"]}</td></tr>'
        for d in days
    )
    total_llm = sum(d["llm_calls"] for d in days)
    avg_active = sum(d["active_users"] for d in days) / len(days)
    p = report["period"]
    period = f'{p["from"][8:10]}.{p["from"][5:7]}–{p["to"][8:10]}.{p["to"][5:7]}.{p["to"][:4]}'
    definitions = "".join(f"<li>{html.escape(text)}</li>" for text in report["definitions"].values())
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Слышу Рядом — метрики</title>
<style>
:root {{ --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#e5e5ea; --a:#2f6fdf; --b:#d9822b; --c:#2e9d6a; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#141416; --fg:#f2f2f4; --muted:#a1a1a8; --line:#2c2c30; --a:#6b9bff; --b:#f0a65a; --c:#4cc38a; }} }}
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
table {{ width:100%; border-collapse:collapse; margin-top:22px; font-variant-numeric:tabular-nums; }}
th, td {{ padding:8px 6px; border-bottom:1px solid var(--line); text-align:right; }}
th:first-child, td:first-child {{ text-align:left; }} th {{ font-size:13px; color:var(--muted); font-weight:600; }}
ul {{ padding-left:18px; }} li {{ margin:4px 0; }}
</style></head>
<body><main>
<h1>Слышу Рядом — метрики</h1>
<div class="muted">{period}, сутки по Москве · обновлено {html.escape(report["updated_at"][11:16])} МСК {report["updated_at"][8:10]}.{report["updated_at"][5:7]}</div>
<div class="kpi">
<div><span class="muted">Активные в среднем за сутки</span><b>{f"{avg_active:.1f}".replace(".", ",")}</b></div>
<div><span class="muted">Вызовов LLM за 7 дней</span><b>{total_llm}</b></div>
<div><span class="muted">Пользователей на {p["to"][8:10]}.{p["to"][5:7]}</span><b>{days[-1]["users_total"]}</b></div>
</div>
{chart(days, "active_users", "Активные пользователи (DAU)", "var(--a)")}
{chart(days, "llm_calls", "Вызовы LLM", "var(--b)")}
{chart(days, "users_total", "Пользователи, всего", "var(--c)")}
<table><thead><tr><th>Дата</th><th>Активные (DAU)</th><th>Вызовы LLM</th><th>Пользователи, всего</th></tr></thead>
<tbody>{rows}</tbody></table>
<h2>Как считается</h2>
<ul>{definitions}<li>Числа пересчитываются раз в час. JSON с теми же числами — <code>/dashboard/api</code>.</li></ul>
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


def main() -> None:
    if not PASSWORD:
        raise SystemExit("DASHBOARD_PASSWORD не задан")
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    log.info("слушаю :%s", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
