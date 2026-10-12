"""Диалоги на диске: SQLite (стандартная библиотека), один файл на томе пода.

Рабочий набор остаётся в памяти (`DialogStore`): сюда он дублируется в фоне, отсюда по человеку загружается при первом
обращении. Реплика пода одна, `strategy: Recreate` оставляет одного писателя, поэтому одного файла и одной блокировки хватает.
Настоящая БД агента (design D6, PostgreSQL с pgvector) подставляется на место этого класса; интерфейс — `open`, `close`,
`load_user`, `apply`, `erase_user`.

Схема версионируется через `PRAGMA user_version`. Все обращения идут из рабочего потока (`asyncio.to_thread`), по одному.
В том же файле и через то же соединение живёт память агента (таблицы `memory_*`, app/memory/store.py): стирание человека обязано
быть одной транзакцией с его диалогами, поэтому второго файла и второго соединения нет.

Версии схемы: 1 — диалоги; 2 — колонки памяти у диалогов и таблицы памяти (спецификация памяти, раздел 5). Переход 1 → 2 идёт
одной транзакцией при старте независимо от `MEMORY_MODE`. Откат образа на агента со схемой 1 не поддерживается: старый агент
видит версию 2, отказывается открывать файл и на стирание отвечает 503 (иначе он стирал бы людей, не трогая их память).
"""

import json
import logging
import sqlite3
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

logger = logging.getLogger("agent.db")

T = TypeVar("T")

SCHEMA_VERSION = 2

# Версия 1: диалоги, сообщения, идентификаторы клиента, выбор голоса.
SCHEMA_V1 = (
    """CREATE TABLE IF NOT EXISTS dialogs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    summary     TEXT,
    greeting    TEXT,
    voice       TEXT NOT NULL,
    reply_index INTEGER NOT NULL DEFAULT 0
)""",
    "CREATE INDEX IF NOT EXISTS dialogs_user_started ON dialogs (user_id, started_at)",
    """CREATE TABLE IF NOT EXISTS messages (
    id         TEXT NOT NULL,
    dialog_id  TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (dialog_id, id)
)""",
    "CREATE INDEX IF NOT EXISTS messages_dialog_position ON messages (dialog_id, position)",
    """CREATE TABLE IF NOT EXISTS client_ids (
    dialog_id  TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (dialog_id, client_id)
)""",
    """CREATE TABLE IF NOT EXISTS voice_prefs (
    user_id TEXT PRIMARY KEY,
    voice   TEXT NOT NULL
)""",
)

# Переход 1 → 2: память агента (MEM-5.1, MEM-5.3). Тексты есть только у фактов; события и задания хранят коды и id (I4).
MIGRATION_V2 = (
    "ALTER TABLE dialogs ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'on' CHECK (memory_mode IN ('on', 'off'))",
    "ALTER TABLE dialogs ADD COLUMN crisis_seen INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE dialogs ADD COLUMN memory_extracted_at TEXT",
    """CREATE TABLE memory_settings (
    user_id          TEXT PRIMARY KEY,
    enabled          INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    consent_version  TEXT,
    consent_at       TEXT,
    epoch_at         TEXT,
    tone_hint_until  TEXT,
    updated_at       TEXT NOT NULL
)""",
    """CREATE TABLE memory_facts (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    category          TEXT NOT NULL CHECK (category IN
                        ('style', 'boundary', 'person', 'situation', 'goal', 'works', 'interest', 'recap')),
    text              TEXT NOT NULL,
    slots             TEXT,
    importance        INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
    confidence        REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    status            TEXT NOT NULL CHECK (status IN ('candidate', 'proposed', 'active', 'pinned', 'expired')),
    origin            TEXT NOT NULL CHECK (origin IN ('auto', 'user_said', 'user_edit')),
    sensitivity       TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive')),
    supersedes_id     TEXT,
    norm_hash         TEXT NOT NULL,
    confirm_count     INTEGER NOT NULL DEFAULT 0,
    seen_by_user      INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    last_confirmed_at TEXT,
    expires_at        TEXT,
    purge_after       TEXT
)""",
    "CREATE INDEX memory_facts_user_status ON memory_facts (user_id, status)",
    "CREATE INDEX memory_facts_purge ON memory_facts (purge_after) WHERE purge_after IS NOT NULL",
    """CREATE TABLE memory_fact_sources (
    fact_id     TEXT NOT NULL REFERENCES memory_facts (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    dialog_id   TEXT NOT NULL,
    message_ids TEXT NOT NULL,
    PRIMARY KEY (fact_id, dialog_id)
)""",
    "CREATE INDEX memory_fact_sources_dialog ON memory_fact_sources (dialog_id)",
    """CREATE TABLE memory_tombstones (
    user_id    TEXT NOT NULL,
    norm_hash  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, norm_hash)
)""",
    """CREATE TABLE memory_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT NOT NULL,
    fact_id   TEXT,
    op        TEXT NOT NULL CHECK (op IN
                ('add', 'update', 'confirm', 'supersede', 'expire', 'user_add', 'user_edit', 'user_confirm', 'user_delete',
                 'forget_all')),
    actor     TEXT NOT NULL CHECK (actor IN ('extractor', 'user', 'system')),
    dialog_id TEXT,
    at        TEXT NOT NULL
)""",
    "CREATE INDEX memory_events_user_at ON memory_events (user_id, at)",
    "CREATE INDEX memory_events_dialog ON memory_events (dialog_id)",
    """CREATE TABLE memory_jobs (
    dialog_id       TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'skipped', 'failed')),
    skip_reason     TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    run_after       TEXT NOT NULL,
    last_error_code TEXT,
    created_at      TEXT NOT NULL,
    done_at         TEXT
)""",
    "CREATE INDEX memory_jobs_due ON memory_jobs (status, run_after)",
)

# Что выполнить, чтобы файл версии N - 1 стал версии N. Пустая база сразу создаётся в последней версии.
MIGRATIONS: dict[int, tuple[str, ...]] = {2: MIGRATION_V2}

# Таблицы памяти: стирание человека чистит каждую явным DELETE по user_id в одной транзакции с диалогами (MEM-13.2, I8).
MEMORY_TABLES = (
    "memory_fact_sources",
    "memory_facts",
    "memory_tombstones",
    "memory_events",
    "memory_jobs",
    "memory_settings",
)


def migration_statements(version: int) -> list[str]:
    """Что выполнить над файлом версии `version` (0 — пустой), чтобы он стал версии SCHEMA_VERSION."""
    statements = list(SCHEMA_V1) if version < 1 else []
    for target in range(max(version, 1) + 1, SCHEMA_VERSION + 1):
        statements.extend(MIGRATIONS[target])
    return statements


class DialogDbError(Exception):
    """База диалогов не открылась, повреждена или новее агента."""


@dataclass
class StoredDialog:
    """Диалог, как он лежит на диске: плоские значения без привязки к классам хранилища."""

    id: str
    user_id: str
    started_at: str
    ended_at: str | None
    summary: dict[str, Any] | None
    greeting: str | None
    voice: str
    reply_index: int
    memory_mode: str = "on"
    crisis_seen: bool = False
    memory_extracted_at: str | None = None
    messages: list[tuple[str, str, str, str]] = field(default_factory=list)  # (id, role, text, created_at) по порядку
    client_ids: dict[str, str] = field(default_factory=dict)


@dataclass
class DialogWrite:
    """Что записать за один раз по одному диалогу: строка диалога, новые или изменённые сообщения, идентификаторы клиента."""

    dialog_id: str
    # (id, user_id, started_at, ended_at, summary_json, greeting, voice, reply_index, memory_mode, crisis_seen)
    row: tuple[Any, ...]
    messages: list[tuple[Any, ...]] = field(default_factory=list)  # (id, dialog_id, position, role, text, created_at)
    client_ids: list[tuple[str, str, str]] = field(default_factory=list)  # (dialog_id, client_id, message_id)
    pref: tuple[str, str] | None = None  # (user_id, voice), если выбор голоса изменился


def encode_summary(summary: dict[str, Any] | None) -> str | None:
    return None if summary is None else json.dumps(summary, ensure_ascii=False)


def clean(value: Any) -> Any:
    """Строка, которую SQLite точно запишет: непарный суррогат (оборванная половина эмодзи, `\\ud83d` в JSON клиента) не кодируется в
    UTF-8 и ронял бы всю транзакцию, а с ней и запись диалогов остальных людей. Такой символ заменяется на «?»."""
    return value.encode("utf-8", "replace").decode("utf-8") if isinstance(value, str) else value


def clean_row(row: tuple[Any, ...]) -> tuple[Any, ...]:
    return tuple(clean(item) for item in row)


class DialogDatabase:
    def __init__(self, path: str) -> None:
        self.path = path
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    def open(self) -> None:
        """Открыть файл, создать каталог и схему, проверить целостность. Исключение — `DialogDbError`."""
        try:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = FULL")  # данные людей: лучше лишняя миллисекунда, чем потерянная реплика
            conn.execute("PRAGMA secure_delete = ON")  # стёртое по запросу человека затирается нулями, а не лежит в свободных страницах
            check = conn.execute("PRAGMA quick_check").fetchone()
            if not check or check[0] != "ok":
                raise DialogDbError(f"проверка целостности не прошла: {check[0] if check else 'нет ответа'}")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise DialogDbError(f"база версии {version} новее агента (версия схемы {SCHEMA_VERSION})")
            if version < SCHEMA_VERSION:
                self._migrate(conn, version)
            self._conn = conn
        except DialogDbError:
            raise
        except (sqlite3.Error, OSError) as error:
            raise DialogDbError(f"{type(error).__name__}: {error}") from error
        dialogs, messages = self.counts()
        logger.info("dialog db opened path=%s schema=v%d dialogs=%d messages=%d", self.path, SCHEMA_VERSION, dialogs, messages)

    @staticmethod
    def _migrate(conn: sqlite3.Connection, version: int) -> None:
        """Довести схему до текущей одной транзакцией: при сбое файл остаётся в прежней версии и рабочим (DDL в SQLite
        транзакционен). Файл текущей версии сюда не попадает, поэтому повторный запуск ничего не делает."""
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in migration_statements(version):
                conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        if version:
            logger.info("dialog db migrated schema v%d -> v%d", version, SCHEMA_VERSION)

    def close(self) -> None:
        with self._lock:
            if self._conn is None:
                return
            try:
                self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error as error:
                logger.warning("dialog db checkpoint failed: %s", error)
            self._conn.close()
            self._conn = None

    def _connection(self) -> sqlite3.Connection:
        if self._conn is None:
            raise DialogDbError("база диалогов не открыта")
        return self._conn

    def counts(self) -> tuple[int, int]:
        with self._lock:
            conn = self._connection()
            return (
                conn.execute("SELECT COUNT(*) FROM dialogs").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
            )

    def load_user(self, user_id: str) -> tuple[list[StoredDialog], str | None]:
        """Все диалоги человека (от старых к новым) с сообщениями и выбранный им голос."""
        with self._lock:
            conn = self._connection()
            dialogs = {
                row[0]: StoredDialog(
                    id=row[0],
                    user_id=row[1],
                    started_at=row[2],
                    ended_at=row[3],
                    summary=json.loads(row[4]) if row[4] else None,
                    greeting=row[5],
                    voice=row[6],
                    reply_index=row[7],
                    memory_mode=row[8],
                    crisis_seen=bool(row[9]),
                    memory_extracted_at=row[10],
                )
                for row in conn.execute(
                    "SELECT id, user_id, started_at, ended_at, summary, greeting, voice, reply_index, memory_mode, crisis_seen, "
                    "memory_extracted_at FROM dialogs WHERE user_id = ? ORDER BY started_at, id",
                    (user_id,),
                )
            }
            for dialog_id, message_id, role, text, created_at in conn.execute(
                "SELECT m.dialog_id, m.id, m.role, m.text, m.created_at FROM messages m "
                "JOIN dialogs d ON d.id = m.dialog_id WHERE d.user_id = ? ORDER BY m.dialog_id, m.position",
                (user_id,),
            ):
                dialogs[dialog_id].messages.append((message_id, role, text, created_at))
            for dialog_id, client_id, message_id in conn.execute(
                "SELECT c.dialog_id, c.client_id, c.message_id FROM client_ids c "
                "JOIN dialogs d ON d.id = c.dialog_id WHERE d.user_id = ?",
                (user_id,),
            ):
                dialogs[dialog_id].client_ids[client_id] = message_id
            pref = conn.execute("SELECT voice FROM voice_prefs WHERE user_id = ?", (user_id,)).fetchone()
        return list(dialogs.values()), (pref[0] if pref else None)

    def apply(self, writes: list[DialogWrite]) -> None:
        """Записать пачку одной транзакцией: либо всё, либо ничего."""
        with self._lock:
            conn = self._connection()
            with conn:
                for write in writes:
                    # memory_mode неизменяем после создания, crisis_seen только растёт, а memory_extracted_at пишет лишь воркер
                    # памяти отдельным запросом: писатель диалогов его не трогает, иначе затёр бы отметку воркера (MEM-5.3).
                    conn.execute(
                        "INSERT INTO dialogs (id, user_id, started_at, ended_at, summary, greeting, voice, reply_index, "
                        "memory_mode, crisis_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET "
                        "ended_at = excluded.ended_at, summary = excluded.summary, greeting = excluded.greeting, "
                        "voice = excluded.voice, reply_index = excluded.reply_index, "
                        "crisis_seen = MAX(dialogs.crisis_seen, excluded.crisis_seen)",
                        clean_row(write.row),
                    )
                    conn.executemany(
                        "INSERT INTO messages (id, dialog_id, position, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT (dialog_id, id) DO UPDATE SET text = excluded.text, position = excluded.position",
                        [clean_row(item) for item in write.messages],
                    )
                    conn.executemany(
                        "INSERT OR IGNORE INTO client_ids (dialog_id, client_id, message_id) VALUES (?, ?, ?)",
                        [clean_row(item) for item in write.client_ids],
                    )
                    if write.pref is not None:
                        conn.execute(
                            "INSERT INTO voice_prefs (user_id, voice) VALUES (?, ?) "
                            "ON CONFLICT (user_id) DO UPDATE SET voice = excluded.voice",
                            clean_row(write.pref),
                        )

    def run(self, operation: Callable[[sqlite3.Connection], T]) -> T:
        """Выполнить операцию над базой одной транзакцией, под тем же замком, что запись диалогов (память агента,
        app/memory/store.py). Исключение откатывает всё, что операция успела сделать."""
        with self._lock:
            conn = self._connection()
            with conn:
                return operation(conn)

    def checkpoint(self) -> None:
        """Перенести журнал WAL в файл и усечь его: после удаления прежние образы страниц с текстом не остаются в журнале."""
        with self._lock:
            self._connection().execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def erase_user(self, user_id: str) -> None:
        """Стереть всё о человеке (диалоги, сообщения, выбор голоса и всю память) одной транзакцией. Идемпотентно."""
        with self._lock:
            conn = self._connection()
            with conn:
                conn.execute("DELETE FROM dialogs WHERE user_id = ?", (user_id,))  # сообщения уходят каскадом
                conn.execute("DELETE FROM voice_prefs WHERE user_id = ?", (user_id,))
                for table in MEMORY_TABLES:  # явно по каждой таблице: на каскад внешних ключей память не полагается
                    conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
            # Прежние образы страниц с текстом лежат в журнале WAL до его усечения: без этого «стёрто» неправда для файла на диске.
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def delete_dialog(self, user_id: str, dialog_id: str, forget_derived: bool) -> None:
        """Удалить один диалог человека целиком: сообщения, идентификаторы клиента, задание и события памяти по нему.

        `forget_derived`: факты, у которых этот диалог был единственным источником и которые извлечены автоматически, удаляются
        (без надгробия: человек их не отвергал); у остальных фактов ссылка на диалог просто убирается (MEM-13.4).
        """
        with self._lock:
            conn = self._connection()
            with conn:
                if forget_derived:
                    conn.execute(
                        "DELETE FROM memory_facts WHERE user_id = ? AND origin = 'auto' AND id IN "
                        "(SELECT fact_id FROM memory_fact_sources WHERE dialog_id = ? AND user_id = ?) AND NOT EXISTS "
                        "(SELECT 1 FROM memory_fact_sources s WHERE s.fact_id = memory_facts.id AND s.dialog_id != ?)",
                        (user_id, dialog_id, user_id, dialog_id),
                    )
                conn.execute("DELETE FROM memory_fact_sources WHERE dialog_id = ? AND user_id = ?", (dialog_id, user_id))
                conn.execute("DELETE FROM memory_events WHERE dialog_id = ? AND user_id = ?", (dialog_id, user_id))
                conn.execute("DELETE FROM memory_jobs WHERE dialog_id = ? AND user_id = ?", (dialog_id, user_id))
                conn.execute("DELETE FROM dialogs WHERE id = ? AND user_id = ?", (dialog_id, user_id))
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
