"""Диалоги в PostgreSQL (`DIALOG_DATABASE_URL`): единственное хранилище диалогов агента.

Рабочий набор остаётся в памяти (`DialogStore`): сюда он дублируется в фоне, отсюда по человеку загружается при первом
обращении. Реплика пода одна, `strategy: Recreate` оставляет одного писателя. В бою это база `agent` в CNPG
`ryadom-db` (k8s/agent/README.md «Хранилище диалогов»).

`DialogStore` зовёт базу синхронно, через `asyncio.to_thread`, по одному обращению под замком. Драйвер psycopg3
синхронный: асинхронный здесь ничего не дал бы, а зависимостей и кода было бы больше. Каждая операция берёт соединение
из `ConnectionPool`; перед выдачей пул проверяет его и заменяет разорванное, поэтому после сбоя сети или смены primary
агент восстанавливается без перезапуска. Соединение в `autocommit=True`: `conn.transaction()` тогда сам делает
BEGIN/COMMIT на записях, а чтения не оставляют висячую неявную транзакцию (иначе она держала бы блокировки, а записи
через savepoint никогда не коммитились).

Схема — только диалоговые таблицы (`dialogs`, `messages`, `client_ids`, `voice_prefs`, `model_usage`). Таблиц памяти
здесь нет: память агента — Cognee (`app/memory/cognee_backend.py`), стирание человека в памяти делает она. DDL
идемпотентен (`CREATE TABLE IF NOT EXISTS`) и выполняется при каждом `open`: своих миграций у агента нет, изменения
схемы — только добавочные. Timestamps хранятся TEXT в ISO: формат задан писателем (`DialogStore`), переносимость
важнее типовой строгости.

Расход моделей (`model_usage`) — строки «модель, задача, input/output, модальность, единица, количество» по сообщению, которое
этот вызов модели произвёл, или по диалогу (`message_id` NULL), если сообщения нет: ответ выброшен, озвучена фиксированная фраза.
Агент их только дописывает и никогда не читает; это данные для отчётов (agent/README.md, «Расход моделей»).
"""

import json
import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool, PoolTimeout

logger = logging.getLogger("agent.db")

DDL = (
    """CREATE TABLE IF NOT EXISTS dialogs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    summary     TEXT,
    greeting    TEXT,
    voice       TEXT NOT NULL,
    reply_index INTEGER NOT NULL DEFAULT 0,
    memory_mode TEXT NOT NULL DEFAULT 'on' CHECK (memory_mode IN ('on', 'off')),
    crisis_seen INTEGER NOT NULL DEFAULT 0,
    memory_extracted_at TEXT
)""",
    "CREATE INDEX IF NOT EXISTS dialogs_user_started ON dialogs (user_id, started_at)",
    """CREATE TABLE IF NOT EXISTS messages (
    id         TEXT NOT NULL,
    dialog_id  TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    role       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    audio_seconds DOUBLE PRECISION,
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
    """CREATE TABLE IF NOT EXISTS model_usage (
    dialog_id  TEXT NOT NULL REFERENCES dialogs (id) ON DELETE CASCADE,
    message_id TEXT,
    created_at TEXT NOT NULL,
    model      TEXT NOT NULL,
    task       TEXT NOT NULL,
    direction  TEXT NOT NULL,
    modality   TEXT NOT NULL,
    unit       TEXT NOT NULL,
    amount     DOUBLE PRECISION NOT NULL
)""",
    "CREATE INDEX IF NOT EXISTS model_usage_dialog ON model_usage (dialog_id, message_id)",
    # Настройки памяти человека: «Память» включена или на паузе и согласие. Переживают перезапуск и выгрузку (PROTEUS-242).
    """CREATE TABLE IF NOT EXISTS memory_settings (
    user_id             TEXT PRIMARY KEY,
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    sensitive_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
    chat_search_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    consent_version     TEXT,
    consent_at          TEXT,
    updated_at          TEXT NOT NULL
)""",
    # Заметки о человеке (слой 1 памяти, PROTEUS-242): текст до 200 знаков, полнотекстовый поиск по-русски.
    """CREATE TABLE IF NOT EXISTS memory_notes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    text       VARCHAR(200) NOT NULL,
    sensitive  BOOLEAN NOT NULL DEFAULT FALSE,
    event_date DATE,
    dialog_id  TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    search     TSVECTOR GENERATED ALWAYS AS (to_tsvector('russian', text)) STORED
)""",
    "CREATE INDEX IF NOT EXISTS memory_notes_user_created ON memory_notes (user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS memory_notes_search ON memory_notes USING GIN (search)",
    # Очередь операций Cognee с повторами (индекс прошлых разговоров, слой 2).
    """CREATE TABLE IF NOT EXISTS memory_outbox (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL,
    op         TEXT NOT NULL,
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts   INTEGER NOT NULL DEFAULT 0,
    next_at    TEXT NOT NULL,
    created_at TEXT NOT NULL
)""",
    "CREATE INDEX IF NOT EXISTS memory_outbox_next ON memory_outbox (next_at)",
    "ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS memory_notes_cursor TEXT",
    "ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS cognee_data_id TEXT",
)


class DialogDbError(Exception):
    """База диалогов не открылась или запрос не удался."""


@dataclass
class StoredDialog:
    """Диалог, как он лежит в хранилище: плоские значения без привязки к классам хранилища."""

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
    # (id, role, text, created_at, audio_seconds) по порядку
    messages: list[tuple[str, str, str, str, float | None]] = field(default_factory=list)
    client_ids: dict[str, str] = field(default_factory=dict)


@dataclass
class DialogWrite:
    """Что записать за один раз по одному диалогу: строка диалога, новые или изменённые сообщения, идентификаторы клиента."""

    dialog_id: str
    # (id, user_id, started_at, ended_at, summary_json, greeting, voice, reply_index, memory_mode, crisis_seen)
    row: tuple[Any, ...]
    # (id, dialog_id, position, role, text, created_at, audio_seconds)
    messages: list[tuple[Any, ...]] = field(default_factory=list)
    client_ids: list[tuple[str, str, str]] = field(default_factory=list)  # (dialog_id, client_id, message_id)
    pref: tuple[str, str] | None = None  # (user_id, voice), если выбор голоса изменился
    # Новые строки расхода: (dialog_id, message_id, created_at, model, task, direction, modality, unit, amount)
    usage: list[tuple[Any, ...]] = field(default_factory=list)


def encode_summary(summary: dict[str, Any] | None) -> str | None:
    return None if summary is None else json.dumps(summary, ensure_ascii=False)


def clean(value: Any) -> Any:
    """Строка, которую база точно запишет: непарный суррогат (оборванная половина эмодзи, `\\ud83d` в JSON клиента) не кодируется в
    UTF-8 и ронял бы всю транзакцию, а с ней и запись диалогов остальных людей. Такой символ заменяется на «?»."""
    return value.encode("utf-8", "replace").decode("utf-8") if isinstance(value, str) else value


def clean_row(row: tuple[Any, ...]) -> tuple[Any, ...]:
    return tuple(clean(item) for item in row)


class DialogDatabase:
    """Хранилище диалогов в PostgreSQL. Интерфейс: `open`, `close`, `load_user`, `apply`, `erase_user`,
    `delete_dialog`, `counts`, `checkpoint` (нет-оп, нужен `DialogStore`)."""

    label = "postgres"

    def __init__(
        self,
        dsn: str,
        *,
        min_size: int = 1,
        max_size: int = 4,
        max_idle: float = 300,
        max_lifetime: float = 3600,
    ) -> None:
        """Сохраняет параметры пула PostgreSQL."""
        self.dsn = dsn
        self._min_size = min_size
        self._max_size = max_size
        self._max_idle = max_idle
        self._max_lifetime = max_lifetime
        self._pool: ConnectionPool | None = None
        self._lock = threading.Lock()

    @staticmethod
    def _configure(conn: psycopg.Connection) -> None:
        """Настраивает новое соединение пула."""
        conn.autocommit = True
        conn.prepare_threshold = None

    def open(self) -> None:
        """Открывает пул и гарантирует схему. Исключение — `DialogDbError`."""
        pool: ConnectionPool | None = None
        try:
            pool = ConnectionPool(
                self.dsn,
                min_size=self._min_size,
                max_size=self._max_size,
                max_idle=self._max_idle,
                max_lifetime=self._max_lifetime,
                timeout=10,
                kwargs={"connect_timeout": 10, "application_name": "agent"},
                configure=self._configure,
                check=ConnectionPool.check_connection,
                open=False,
            )
            pool.open(wait=True)
            with pool.connection() as conn, conn.transaction():
                for statement in DDL:
                    conn.execute(statement)
            self._pool = pool
        except DialogDbError:
            raise
        except (psycopg.Error, PoolTimeout, OSError) as error:
            if pool is not None:
                pool.close()
            raise DialogDbError(f"{type(error).__name__}: {error}") from error
        dialogs, messages = self.counts()
        logger.info("dialog db opened postgres dialogs=%d messages=%d", dialogs, messages)

    def close(self) -> None:
        """Закрывает пул и все его соединения."""
        with self._lock:
            if self._pool is None:
                return
            self._pool.close()
            self._pool = None

    @contextmanager
    def _connection(self) -> Iterator[psycopg.Connection]:
        """Выдаёт проверенное соединение из пула на одну операцию."""
        if self._pool is None:
            raise DialogDbError("база диалогов не открыта")
        try:
            with self._pool.connection() as conn:
                yield conn
        except (psycopg.Error, PoolTimeout, OSError) as error:
            raise DialogDbError(f"{type(error).__name__}: {error}") from error

    def counts(self) -> tuple[int, int]:
        """Возвращает число диалогов и сообщений."""
        with self._lock, self._connection() as conn:
            return (
                conn.execute("SELECT COUNT(*) FROM dialogs").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
            )

    def load_user(self, user_id: str) -> tuple[list[StoredDialog], str | None]:
        """Все диалоги человека (от старых к новым) с сообщениями и выбранный им голос."""
        with self._lock, self._connection() as conn:
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
                    "memory_extracted_at FROM dialogs WHERE user_id = %s ORDER BY started_at, id",
                    (user_id,),
                )
            }
            for dialog_id, message_id, role, text, created_at, audio_seconds in conn.execute(
                "SELECT m.dialog_id, m.id, m.role, m.text, m.created_at, m.audio_seconds FROM messages m "
                "JOIN dialogs d ON d.id = m.dialog_id WHERE d.user_id = %s ORDER BY m.dialog_id, m.position",
                (user_id,),
            ).fetchall():
                dialogs[dialog_id].messages.append((message_id, role, text, created_at, audio_seconds))
            for dialog_id, client_id, message_id in conn.execute(
                "SELECT c.dialog_id, c.client_id, c.message_id FROM client_ids c "
                "JOIN dialogs d ON d.id = c.dialog_id WHERE d.user_id = %s",
                (user_id,),
            ).fetchall():
                dialogs[dialog_id].client_ids[client_id] = message_id
            pref = conn.execute("SELECT voice FROM voice_prefs WHERE user_id = %s", (user_id,)).fetchone()
        return list(dialogs.values()), (pref[0] if pref else None)

    def apply(self, writes: list[DialogWrite]) -> None:
        """Записать пачку одной транзакцией: либо всё, либо ничего."""
        with (
            self._lock,
            self._connection() as conn,
            conn.cursor() as cur,
            conn.transaction(),
        ):
            for write in writes:
                # memory_mode неизменяем после создания, crisis_seen только растёт, memory_extracted_at писатель
                # диалогов не трогает (это отметка бэкенда памяти о забранном диалоге).
                cur.execute(
                    "INSERT INTO dialogs (id, user_id, started_at, ended_at, summary, greeting, voice, reply_index, "
                    "memory_mode, crisis_seen) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (id) DO UPDATE SET "
                    "ended_at = EXCLUDED.ended_at, summary = EXCLUDED.summary, greeting = EXCLUDED.greeting, "
                    "voice = EXCLUDED.voice, reply_index = EXCLUDED.reply_index, "
                    "crisis_seen = GREATEST(dialogs.crisis_seen, EXCLUDED.crisis_seen)",
                    clean_row(write.row),
                )
                cur.executemany(
                    "INSERT INTO messages (id, dialog_id, position, role, text, created_at, audio_seconds) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (dialog_id, id) DO UPDATE SET "
                    "text = EXCLUDED.text, position = EXCLUDED.position, audio_seconds = EXCLUDED.audio_seconds",
                    [clean_row(item) for item in write.messages],
                )
                cur.executemany(
                    "INSERT INTO model_usage (dialog_id, message_id, created_at, model, task, direction, modality, "
                    "unit, amount) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    [clean_row(item) for item in write.usage],
                )
                cur.executemany(
                    "INSERT INTO client_ids (dialog_id, client_id, message_id) VALUES (%s, %s, %s) "
                    "ON CONFLICT DO NOTHING",
                    [clean_row(item) for item in write.client_ids],
                )
                if write.pref is not None:
                    cur.execute(
                        "INSERT INTO voice_prefs (user_id, voice) VALUES (%s, %s) "
                        "ON CONFLICT (user_id) DO UPDATE SET voice = EXCLUDED.voice",
                        clean_row(write.pref),
                    )

    def checkpoint(self) -> None:
        """Нет-оп: метод нужен контракту `DialogStore`; журнал транзакций ведёт кластер PostgreSQL."""

    def erase_user(self, user_id: str) -> None:
        """Стереть всё о человеке (диалоги с сообщениями, расходом и идентификаторами — каскадом, выбор голоса, настройки
        памяти) одной транзакцией. Идемпотентно. Данные памяти в Cognee стирает бэкенд памяти."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("DELETE FROM dialogs WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM voice_prefs WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM memory_settings WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM memory_notes WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM memory_outbox WHERE user_id = %s", (user_id,))

    def get_memory_settings(self, user_id: str) -> tuple[bool, str | None, str | None] | None:
        """Настройки памяти человека: (включена, версия согласия, когда). None — человек их ещё не задавал."""
        with self._lock, self._connection() as conn:
            row = conn.execute(
                "SELECT enabled, consent_version, consent_at FROM memory_settings WHERE user_id = %s", (user_id,)
            ).fetchone()
        return None if row is None else (bool(row[0]), row[1], row[2])

    # ─── заметки о человеке ───────────────────────────────────────────────────

    _NOTE_COLUMNS = "id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at"

    def list_notes(
        self, user_id: str, since: str | None = None, kinds: tuple[str, ...] | None = None
    ) -> list[tuple[Any, ...]]:
        """Заметки человека, новые сверху: (id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at)."""
        sql = f"SELECT {self._NOTE_COLUMNS} FROM memory_notes WHERE user_id = %s"
        args: list[Any] = [user_id]
        if since:
            sql += " AND created_at >= %s"
            args.append(since)
        if kinds:
            sql += " AND kind = ANY(%s)"
            args.append(list(kinds))
        with self._lock, self._connection() as conn:
            return [tuple(row) for row in conn.execute(sql + " ORDER BY created_at DESC, id", args).fetchall()]

    def count_notes(self, user_id: str) -> int:
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT count(*) FROM memory_notes WHERE user_id = %s", (user_id,)).fetchone()
        return int(row[0]) if row else 0

    def add_note(self, note: tuple[Any, ...]) -> None:
        """(id, user_id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at)."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "INSERT INTO memory_notes (id, user_id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                tuple(clean(item) for item in note),
            )

    def update_note(self, user_id: str, note_id: str, text: str, updated_at: str) -> bool:
        with self._lock, self._connection() as conn, conn.transaction():
            cursor = conn.execute(
                "UPDATE memory_notes SET text = %s, updated_at = %s WHERE id = %s AND user_id = %s",
                (clean(text), updated_at, note_id, user_id),
            )
            return cursor.rowcount > 0

    def delete_note(self, user_id: str, note_id: str) -> bool:
        with self._lock, self._connection() as conn, conn.transaction():
            return conn.execute("DELETE FROM memory_notes WHERE id = %s AND user_id = %s", (note_id, user_id)).rowcount > 0

    def delete_notes(self, user_id: str, only_sensitive: bool = False) -> int:
        sql = "DELETE FROM memory_notes WHERE user_id = %s" + (" AND sensitive" if only_sensitive else "")
        with self._lock, self._connection() as conn, conn.transaction():
            return conn.execute(sql, (user_id,)).rowcount

    def get_memory_flags(self, user_id: str) -> tuple[bool, bool]:
        """(запоминать чувствительное, опираться на прошлые разговоры); без строки — значения по умолчанию (False, True)."""
        with self._lock, self._connection() as conn:
            row = conn.execute(
                "SELECT sensitive_enabled, chat_search_enabled FROM memory_settings WHERE user_id = %s", (user_id,)
            ).fetchone()
        return (False, True) if row is None else (bool(row[0]), bool(row[1]))

    def put_memory_flags(self, user_id: str, sensitive: bool, chat_search: bool, updated_at: str) -> None:
        """Записать переключатели «Запоминать чувствительное» и «Опираться на прошлые разговоры», не трогая паузу и согласие."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "INSERT INTO memory_settings (user_id, enabled, sensitive_enabled, chat_search_enabled, updated_at) "
                "VALUES (%s, FALSE, %s, %s, %s) ON CONFLICT (user_id) DO UPDATE SET "
                "sensitive_enabled = EXCLUDED.sensitive_enabled, chat_search_enabled = EXCLUDED.chat_search_enabled, "
                "updated_at = EXCLUDED.updated_at",
                (user_id, sensitive, chat_search, updated_at),
            )

    def put_memory_settings(
        self, user_id: str, enabled: bool, consent_version: str | None, consent_at: str | None, updated_at: str
    ) -> None:
        """Записать настройки памяти человека (создаёт строку или заменяет). Остальные переключатели не меняются."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "INSERT INTO memory_settings (user_id, enabled, consent_version, consent_at, updated_at) "
                "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, "
                "consent_version = EXCLUDED.consent_version, consent_at = EXCLUDED.consent_at, "
                "updated_at = EXCLUDED.updated_at",
                (user_id, enabled, clean(consent_version), clean(consent_at), updated_at),
            )

    def delete_dialog(self, user_id: str, dialog_id: str, forget_derived: bool) -> None:
        """Удалить один диалог человека целиком (сообщения и расход уходят каскадом).

        `forget_derived` принимается ради контракта: фактами, выведенными из удалённого диалога, управляет бэкенд
        памяти (Cognee), а не хранилище диалогов.
        """
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("DELETE FROM dialogs WHERE id = %s AND user_id = %s", (dialog_id, user_id))
