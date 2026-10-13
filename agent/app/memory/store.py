"""Таблицы памяти (`memory_*`, MEM-5.1): операции над уже открытым соединением `DialogDatabase`.

Каждая функция синхронна и вызывается внутри `DialogDatabase.run` — под тем же замком и в той же транзакции, что запись
диалогов; второго соединения нет. Стирание человека целиком — `DialogDatabase.erase_user` (одна транзакция с диалогами, I8).
Схема совместима с PostgreSQL (D6): только переносимые типы и запросы.
"""

import json
import sqlite3
from collections.abc import Iterable

from app.memory.models import FACT_COLUMNS, Fact, Job, UserMemorySettings

LIVE_STATUSES = ("candidate", "proposed", "active", "pinned")
_FACT_SELECT = "SELECT " + ", ".join(FACT_COLUMNS) + " FROM memory_facts"
_JOB_COLUMNS = "dialog_id, user_id, status, skip_reason, attempts, run_after, last_error_code, created_at, done_at"


def _marks(items: Iterable[object]) -> str:
    return ", ".join("?" for _ in items)


# ─── Настройки ────────────────────────────────────────────────────────────────


def get_settings(conn: sqlite3.Connection, user_id: str) -> UserMemorySettings:
    row = conn.execute(
        "SELECT enabled, consent_version, consent_at, epoch_at, tone_hint_until, updated_at FROM memory_settings WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        return UserMemorySettings(user_id=user_id)
    return UserMemorySettings(user_id, bool(row[0]), row[1], row[2], row[3], row[4], row[5])


def save_settings(conn: sqlite3.Connection, settings: UserMemorySettings) -> None:
    conn.execute(
        "INSERT INTO memory_settings (user_id, enabled, consent_version, consent_at, epoch_at, tone_hint_until, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, "
        "consent_version = excluded.consent_version, consent_at = excluded.consent_at, epoch_at = excluded.epoch_at, "
        "tone_hint_until = excluded.tone_hint_until, updated_at = excluded.updated_at",
        (
            settings.user_id,
            int(settings.enabled),
            settings.consent_version,
            settings.consent_at,
            settings.epoch_at,
            settings.tone_hint_until,
            settings.updated_at,
        ),
    )


# ─── Факты ────────────────────────────────────────────────────────────────────


def list_facts(conn: sqlite3.Connection, user_id: str, statuses: tuple[str, ...] | None = None) -> list[Fact]:
    if statuses is None:
        rows = conn.execute(_FACT_SELECT + " WHERE user_id = ? ORDER BY created_at, id", (user_id,))
    else:
        rows = conn.execute(
            _FACT_SELECT + f" WHERE user_id = ? AND status IN ({_marks(statuses)}) ORDER BY created_at, id",
            (user_id, *statuses),
        )
    return [Fact.from_row(row) for row in rows]


def get_fact(conn: sqlite3.Connection, user_id: str, fact_id: str) -> Fact | None:
    """Факт этого человека; чужой и несуществующий неразличимы (I5)."""
    row = conn.execute(_FACT_SELECT + " WHERE id = ? AND user_id = ?", (fact_id, user_id)).fetchone()
    return Fact.from_row(row) if row else None


def insert_fact(conn: sqlite3.Connection, fact: Fact) -> None:
    conn.execute(
        f"INSERT INTO memory_facts ({', '.join(FACT_COLUMNS)}) VALUES ({_marks(FACT_COLUMNS)})",
        fact.to_row(),
    )


def update_fact(conn: sqlite3.Connection, fact: Fact) -> None:
    columns = [name for name in FACT_COLUMNS if name not in ("id", "user_id")]
    values = dict(zip(FACT_COLUMNS, fact.to_row(), strict=True))
    conn.execute(
        f"UPDATE memory_facts SET {', '.join(f'{name} = ?' for name in columns)} WHERE id = ? AND user_id = ?",
        (*[values[name] for name in columns], fact.id, fact.user_id),
    )


def delete_fact(conn: sqlite3.Connection, user_id: str, fact_id: str) -> None:
    conn.execute("DELETE FROM memory_fact_sources WHERE fact_id = ? AND user_id = ?", (fact_id, user_id))
    conn.execute("DELETE FROM memory_facts WHERE id = ? AND user_id = ?", (fact_id, user_id))


def count_live(conn: sqlite3.Connection, user_id: str) -> int:
    return conn.execute(
        f"SELECT COUNT(*) FROM memory_facts WHERE user_id = ? AND status IN ({_marks(LIVE_STATUSES)})",
        (user_id, *LIVE_STATUSES),
    ).fetchone()[0]


# ─── Источники ────────────────────────────────────────────────────────────────


def sources(conn: sqlite3.Connection, user_id: str) -> dict[str, list[tuple[str, list[str]]]]:
    """fact_id → [(dialog_id, message_ids)] человека."""
    found: dict[str, list[tuple[str, list[str]]]] = {}
    for fact_id, dialog_id, message_ids in conn.execute(
        "SELECT fact_id, dialog_id, message_ids FROM memory_fact_sources WHERE user_id = ? ORDER BY fact_id, dialog_id",
        (user_id,),
    ):
        found.setdefault(fact_id, []).append((dialog_id, json.loads(message_ids)))
    return found


def add_source(conn: sqlite3.Connection, fact_id: str, user_id: str, dialog_id: str, message_ids: list[str]) -> None:
    """Связать факт с репликами диалога; повтор дописывает новые id реплик (I12)."""
    row = conn.execute(
        "SELECT message_ids FROM memory_fact_sources WHERE fact_id = ? AND dialog_id = ?", (fact_id, dialog_id)
    ).fetchone()
    merged = list(dict.fromkeys([*(json.loads(row[0]) if row else []), *message_ids]))
    conn.execute(
        "INSERT INTO memory_fact_sources (fact_id, user_id, dialog_id, message_ids) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (fact_id, dialog_id) DO UPDATE SET message_ids = excluded.message_ids",
        (fact_id, user_id, dialog_id, json.dumps(merged)),
    )


def copy_sources(conn: sqlite3.Connection, user_id: str, from_fact: str, to_fact: str) -> None:
    for dialog_id, message_ids in conn.execute(
        "SELECT dialog_id, message_ids FROM memory_fact_sources WHERE fact_id = ? AND user_id = ?", (from_fact, user_id)
    ).fetchall():
        add_source(conn, to_fact, user_id, dialog_id, json.loads(message_ids))


def first_dialog(conn: sqlite3.Connection, user_id: str, fact_id: str) -> str | None:
    """Диалог, в котором факт появился (по событию создания): «второй независимый диалог» считается от него."""
    row = conn.execute(
        "SELECT dialog_id FROM memory_events WHERE user_id = ? AND fact_id = ? AND op IN ('add', 'update', 'supersede') "
        "ORDER BY id LIMIT 1",
        (user_id, fact_id),
    ).fetchone()
    return row[0] if row else None


# ─── Надгробия и события ──────────────────────────────────────────────────────


def has_tombstone(conn: sqlite3.Connection, user_id: str, norm_hash: str) -> bool:
    return (
        conn.execute("SELECT 1 FROM memory_tombstones WHERE user_id = ? AND norm_hash = ?", (user_id, norm_hash)).fetchone()
        is not None
    )


def add_tombstone(conn: sqlite3.Connection, user_id: str, norm_hash: str, at: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO memory_tombstones (user_id, norm_hash, created_at) VALUES (?, ?, ?)", (user_id, norm_hash, at)
    )


def add_event(
    conn: sqlite3.Connection, user_id: str, fact_id: str | None, op: str, actor: str, dialog_id: str | None, at: str
) -> None:
    """Событие без текста: что произошло с каким фактом, кто и в каком диалоге (I4)."""
    conn.execute(
        "INSERT INTO memory_events (user_id, fact_id, op, actor, dialog_id, at) VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, fact_id, op, actor, dialog_id, at),
    )


def has_event(conn: sqlite3.Connection, user_id: str, fact_id: str, op: str, dialog_id: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM memory_events WHERE user_id = ? AND fact_id = ? AND op = ? AND dialog_id = ? LIMIT 1",
            (user_id, fact_id, op, dialog_id),
        ).fetchone()
        is not None
    )


def dialog_events(conn: sqlite3.Connection, user_id: str, dialog_id: str) -> list[tuple[str | None, str]]:
    return conn.execute(
        "SELECT fact_id, op FROM memory_events WHERE user_id = ? AND dialog_id = ? ORDER BY id", (user_id, dialog_id)
    ).fetchall()


def events(conn: sqlite3.Connection, user_id: str) -> list[dict[str, str | None]]:
    return [
        {"factId": row[0], "op": row[1], "actor": row[2], "dialogId": row[3], "at": row[4]}
        for row in conn.execute(
            "SELECT fact_id, op, actor, dialog_id, at FROM memory_events WHERE user_id = ? ORDER BY id", (user_id,)
        )
    ]


def mark_seen(conn: sqlite3.Connection, user_id: str, fact_ids: Iterable[str]) -> None:
    ids = list(fact_ids)
    if ids:
        conn.execute(f"UPDATE memory_facts SET seen_by_user = 1 WHERE user_id = ? AND id IN ({_marks(ids)})", (user_id, *ids))


def forget_all(conn: sqlite3.Connection, user_id: str) -> int:
    """«Забыть всё»: факты, источники, события, задания, надгробия человека (настройки и диалоги не трогаются)."""
    count = conn.execute("SELECT COUNT(*) FROM memory_facts WHERE user_id = ?", (user_id,)).fetchone()[0]
    for table in ("memory_fact_sources", "memory_facts", "memory_events", "memory_jobs", "memory_tombstones"):
        conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
    return count


# ─── Задания ──────────────────────────────────────────────────────────────────


def _job(row: tuple[object, ...] | None) -> Job | None:
    return Job(*row) if row else None  # type: ignore[arg-type]


def get_job(conn: sqlite3.Connection, dialog_id: str) -> Job | None:
    return _job(conn.execute(f"SELECT {_JOB_COLUMNS} FROM memory_jobs WHERE dialog_id = ?", (dialog_id,)).fetchone())


def save_job(conn: sqlite3.Connection, job: Job) -> None:
    conn.execute(
        f"INSERT INTO memory_jobs ({_JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dialog_id) DO UPDATE SET "
        "status = excluded.status, skip_reason = excluded.skip_reason, attempts = excluded.attempts, "
        "run_after = excluded.run_after, last_error_code = excluded.last_error_code, done_at = excluded.done_at",
        (
            job.dialog_id,
            job.user_id,
            job.status,
            job.skip_reason,
            job.attempts,
            job.run_after,
            job.last_error_code,
            job.created_at,
            job.done_at,
        ),
    )


def due_jobs(conn: sqlite3.Connection, now: str, limit: int) -> list[Job]:
    rows = conn.execute(
        f"SELECT {_JOB_COLUMNS} FROM memory_jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, dialog_id "
        "LIMIT ?",
        (now, limit),
    ).fetchall()
    return [Job(*row) for row in rows]


def requeue_running(conn: sqlite3.Connection) -> int:
    """После перезапуска: задания, оборванные на середине, снова в очереди."""
    return conn.execute("UPDATE memory_jobs SET status = 'queued' WHERE status = 'running'").rowcount


def retry_failed(conn: sqlite3.Connection, now: str, max_attempts: int) -> int:
    return conn.execute(
        "UPDATE memory_jobs SET status = 'queued' WHERE status = 'failed' AND attempts < ? AND run_after <= ?",
        (max_attempts, now),
    ).rowcount


def job_counts(conn: sqlite3.Connection) -> dict[str, int]:
    return dict(conn.execute("SELECT status, COUNT(*) FROM memory_jobs GROUP BY status").fetchall())


def set_extracted(conn: sqlite3.Connection, dialog_id: str, at: str) -> None:
    """Отметка «извлечено до этой реплики»: пишет только воркер, писатель диалогов её не трогает (MEM-5.3)."""
    conn.execute("UPDATE dialogs SET memory_extracted_at = ? WHERE id = ?", (at, dialog_id))


# ─── Обслуживание (MEM-7.8) ───────────────────────────────────────────────────


def idle_candidates(conn: sqlite3.Connection, idle_cutoff: str, limit: int) -> list[tuple[str, str, str]]:
    """Диалоги с памятью, где после прошлого извлечения появились реплики человека, и они закончились или замолчали:
    (dialog_id, user_id, время последней реплики человека). Завершённые без задания — страховка от сбоя между концом и постановкой."""
    return conn.execute(
        """
        SELECT d.id, d.user_id, lm.at FROM dialogs d
        JOIN memory_settings s ON s.user_id = d.user_id AND s.enabled = 1
        JOIN (SELECT dialog_id, MAX(created_at) AS at FROM messages WHERE role = 'user' GROUP BY dialog_id) lm
            ON lm.dialog_id = d.id
        LEFT JOIN memory_jobs j ON j.dialog_id = d.id
        WHERE d.memory_mode = 'on'
          AND (s.epoch_at IS NULL OR d.started_at > s.epoch_at)
          AND (d.ended_at IS NOT NULL OR lm.at < ?)
          AND (d.memory_extracted_at IS NULL OR lm.at > d.memory_extracted_at)
          AND (j.status IS NULL OR (j.status IN ('done', 'skipped') AND (j.done_at IS NULL OR lm.at > j.done_at)))
        ORDER BY lm.at
        LIMIT ?
        """,
        (idle_cutoff, limit),
    ).fetchall()


def memory_off_due(conn: sqlite3.Connection, cutoff: str, limit: int) -> list[tuple[str, str]]:
    """Разговоры «Без памяти», в которых ничего не происходило дольше срока: (dialog_id, user_id)."""
    return conn.execute(
        """
        SELECT d.id, d.user_id FROM dialogs d
        LEFT JOIN (SELECT dialog_id, MAX(created_at) AS at FROM messages GROUP BY dialog_id) lm ON lm.dialog_id = d.id
        WHERE d.memory_mode = 'off'
          AND MAX(COALESCE(lm.at, d.started_at), COALESCE(d.ended_at, d.started_at), d.started_at) < ?
        LIMIT ?
        """,
        (cutoff, limit),
    ).fetchall()


def expire_due(conn: sqlite3.Connection, now: str, purge_after: str) -> list[tuple[str, str]]:
    """Факты с истёкшим сроком → `expired` (строка стирается через 30 дней). (user_id, fact_id)."""
    due = conn.execute(
        f"SELECT user_id, id FROM memory_facts WHERE status IN ({_marks(LIVE_STATUSES)}) AND expires_at IS NOT NULL "
        "AND expires_at <= ?",
        (*LIVE_STATUSES, now),
    ).fetchall()
    for user_id, fact_id in due:
        conn.execute(
            "UPDATE memory_facts SET status = 'expired', purge_after = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            (purge_after, now, fact_id, user_id),
        )
        add_event(conn, user_id, fact_id, "expire", "system", None, now)
    return due


def purge_due(conn: sqlite3.Connection, now: str) -> list[tuple[str, str]]:
    """Строки, чей срок хранения вышел, стираются целиком (с `secure_delete`). (user_id, fact_id)."""
    due = conn.execute(
        "SELECT user_id, id FROM memory_facts WHERE purge_after IS NOT NULL AND purge_after <= ?", (now,)
    ).fetchall()
    for user_id, fact_id in due:
        delete_fact(conn, user_id, fact_id)
    return due


def inactive_users(conn: sqlite3.Connection, cutoff: str, limit: int) -> list[str]:
    """Люди, у которых есть что забыть, но ни разговоров, ни изменений памяти дольше срока (MEM-7.8 п.6)."""
    rows = conn.execute(
        """
        SELECT s.user_id FROM memory_settings s
        WHERE COALESCE(s.updated_at, '') < :cutoff
          AND NOT EXISTS (SELECT 1 FROM dialogs d WHERE d.user_id = s.user_id
                          AND (d.started_at >= :cutoff OR COALESCE(d.ended_at, '') >= :cutoff))
          AND NOT EXISTS (SELECT 1 FROM messages m JOIN dialogs d ON d.id = m.dialog_id
                          WHERE d.user_id = s.user_id AND m.created_at >= :cutoff)
          AND NOT EXISTS (SELECT 1 FROM memory_facts f WHERE f.user_id = s.user_id
                          AND (f.created_at >= :cutoff OR COALESCE(f.last_confirmed_at, '') >= :cutoff))
          AND NOT EXISTS (SELECT 1 FROM memory_events e WHERE e.user_id = s.user_id AND e.actor = 'user' AND e.at >= :cutoff)
          AND (EXISTS (SELECT 1 FROM memory_facts f WHERE f.user_id = s.user_id)
               OR EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.user_id = s.user_id)
               OR EXISTS (SELECT 1 FROM memory_events e WHERE e.user_id = s.user_id AND e.op != 'forget_all'))
        LIMIT :limit
        """,
        {"cutoff": cutoff, "limit": limit},
    ).fetchall()
    return [row[0] for row in rows]
