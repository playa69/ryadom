"""Диалоги на диске: SQLite (стандартная библиотека), один файл на томе пода.

Рабочий набор остаётся в памяти (`DialogStore`): сюда он дублируется в фоне, отсюда по человеку загружается при первом
обращении. Реплика пода одна, `strategy: Recreate` оставляет одного писателя, поэтому одного файла и одной блокировки хватает.
Настоящая БД агента (design D6, PostgreSQL с pgvector) подставляется на место этого класса; интерфейс — `open`, `close`,
`load_user`, `apply`, `erase_user`.

Схема версионируется через `PRAGMA user_version`. Все обращения идут из рабочего потока (`asyncio.to_thread`), по одному.
"""

import json
import logging
import sqlite3
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("agent.db")

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS dialogs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    summary     TEXT,
    greeting    TEXT,
    voice       TEXT NOT NULL,
    reply_index INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dialogs_user_started ON dialogs (user_id, started_at);
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT NOT NULL,
    dialog_id  TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (dialog_id, id)
);
CREATE INDEX IF NOT EXISTS messages_dialog_position ON messages (dialog_id, position);
CREATE TABLE IF NOT EXISTS client_ids (
    dialog_id  TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (dialog_id, client_id)
);
CREATE TABLE IF NOT EXISTS voice_prefs (
    user_id TEXT PRIMARY KEY,
    voice   TEXT NOT NULL
);
"""


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
    messages: list[tuple[str, str, str, str]] = field(default_factory=list)  # (id, role, text, created_at) по порядку
    client_ids: dict[str, str] = field(default_factory=dict)


@dataclass
class DialogWrite:
    """Что записать за один раз по одному диалогу: строка диалога, новые или изменённые сообщения, идентификаторы клиента."""

    dialog_id: str
    row: tuple[Any, ...]  # (id, user_id, started_at, ended_at, summary_json, greeting, voice, reply_index)
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
                with conn:
                    conn.executescript(SCHEMA)
                    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            self._conn = conn
        except DialogDbError:
            raise
        except (sqlite3.Error, OSError) as error:
            raise DialogDbError(f"{type(error).__name__}: {error}") from error
        dialogs, messages = self.counts()
        logger.info("dialog db opened path=%s schema=v%d dialogs=%d messages=%d", self.path, SCHEMA_VERSION, dialogs, messages)

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
                )
                for row in conn.execute(
                    "SELECT id, user_id, started_at, ended_at, summary, greeting, voice, reply_index "
                    "FROM dialogs WHERE user_id = ? ORDER BY started_at, id",
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
                    conn.execute(
                        "INSERT INTO dialogs (id, user_id, started_at, ended_at, summary, greeting, voice, reply_index) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET "
                        "ended_at = excluded.ended_at, summary = excluded.summary, greeting = excluded.greeting, "
                        "voice = excluded.voice, reply_index = excluded.reply_index",
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

    def erase_user(self, user_id: str) -> None:
        """Стереть всё о человеке (диалоги, сообщения, выбор голоса). Идемпотентно."""
        with self._lock:
            conn = self._connection()
            with conn:
                conn.execute("DELETE FROM dialogs WHERE user_id = ?", (user_id,))  # сообщения уходят каскадом
                conn.execute("DELETE FROM voice_prefs WHERE user_id = ?", (user_id,))
            # Прежние образы страниц с текстом лежат в журнале WAL до его усечения: без этого «стёрто» неправда для файла на диске.
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
