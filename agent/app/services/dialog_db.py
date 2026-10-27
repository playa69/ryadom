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

Схема — диалоговые таблицы (`dialogs`, `messages`, `client_ids`, `voice_prefs`, `model_usage`, `dialog_settings`) и таблицы
памяти (`app/memory/`): настройки `memory_settings`, заметки `memory_notes`, отпечатки их реплик-источников `memory_sources` и очередь
операций Cognee `memory_outbox` (сам индекс прошлых разговоров живёт в Cognee). Стирание человека и удаление разговора мягкие:
диалоги и выбор голоса не удаляются, а получают `deleted_at`; чтения их не видят, запись стёртое не воскрешает, дочерние строки
(сообщения, идентификаторы) остаются до физической очистки: `purge_dialogs` и `purge_voice_prefs` убирают помеченное больше часа назад
пачками (цикл — `app/services/dialog_purge.py`), расход при этом не удаляется, а обезличивается. Производное от разговоров (заметки,
отпечатки, очередь человека, настройки) при стирании удаляется сразу. DDL идемпотентен (`CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) и выполняется при каждом `open`: своих миграций у агента нет, изменения
схемы — только добавочные. Timestamps хранятся TEXT в ISO: формат задан писателем (`DialogStore`), переносимость
важнее типовой строгости.

Расход моделей (`model_usage`) — строки «модель, задача, input/output, модальность, единица, количество» по сообщению, которое
этот вызов модели произвёл, или по диалогу (`message_id` NULL), если сообщения нет: ответ выброшен, озвучена фиксированная фраза.
Агент их только дописывает и никогда не читает; это данные для отчётов (agent/README.md, «Расход моделей»). Связи с `dialogs` на
уровне базы нет (ни внешнего ключа, ни каскада): строка расхода переживает диалог, а при физической очистке разговора у неё
остаются модель, количество и время, `dialog_id` и `message_id` становятся NULL.
"""

import json
import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, fields
from datetime import UTC, datetime
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool, PoolTimeout

logger = logging.getLogger("agent.db")


def iso_utc(moment: datetime) -> str:
    """Отметка времени в формате базы (ISO, миллисекунды, Z): так пишет `deleted_at` и `DialogStore`, и только так её можно
    сравнивать строкой."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _now_iso() -> str:
    return iso_utc(datetime.now(UTC))


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
    """CREATE TABLE IF NOT EXISTS dialog_settings (
    user_id        TEXT PRIMARY KEY,
    recap_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at     TEXT NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS model_usage (
    dialog_id  TEXT,
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
    # Расход переживает диалог (PROTEUS-255): раньше `dialog_id` был NOT NULL с каскадным внешним ключом, и физическое удаление
    # диалога унесло бы с собой учёт расхода. Базы, созданные прежним DDL, переводятся на новую схему здесь (идемпотентно).
    "ALTER TABLE model_usage DROP CONSTRAINT IF EXISTS model_usage_dialog_id_fkey",
    "ALTER TABLE model_usage ALTER COLUMN dialog_id DROP NOT NULL",
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
    # Мягкое стирание: добавочные колонки (идемпотентно); физически помеченные строки убирает `purge_dialogs` (PROTEUS-255).
    "ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS deleted_at TEXT",
    "ALTER TABLE voice_prefs ADD COLUMN IF NOT EXISTS deleted_at TEXT",
    "CREATE INDEX IF NOT EXISTS dialogs_deleted_at ON dialogs (deleted_at)",
    "CREATE INDEX IF NOT EXISTS voice_prefs_deleted_at ON voice_prefs (deleted_at)",
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
    # Реплика-источник заметки (отпечаток, без текста). Удалённая заметка подавляет свою реплику в поиске по прошлым разговорам.
    """CREATE TABLE IF NOT EXISTS memory_sources (
    note_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    dialog_id  TEXT NOT NULL,
    hash       TEXT NOT NULL,
    suppressed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, hash)
)""",
    "CREATE INDEX IF NOT EXISTS memory_sources_user ON memory_sources (user_id, suppressed)",
    "CREATE INDEX IF NOT EXISTS memory_sources_dialog ON memory_sources (dialog_id)",
    "ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS memory_notes_cursor TEXT",
    "ALTER TABLE dialogs ADD COLUMN IF NOT EXISTS cognee_data_id TEXT",
)

# Метки `memory_deletions` агента 0.8.8: «забыть всё» и стирание человека ставили метку, а датасет Cognee не удаляли, и память
# человека с меткой была выключена. При открытии базы метки один раз переносятся в очередь `memory_outbox` (`delete_dataset`), а
# выключенная память записывается строкой `memory_settings`, если строки ещё нет. Перенос идемпотентен: метки удаляются в той же
# транзакции, повторный запуск ничего не находит. Новых меток агент не ставит, при холодной загрузке на них не смотрит.
MEMORY_DELETIONS_TO_OUTBOX = """
WITH moved AS (DELETE FROM memory_deletions RETURNING user_id, deleted_at),
queued AS (
    INSERT INTO memory_outbox (user_id, op, payload, attempts, next_at, created_at)
    SELECT user_id, 'delete_dataset', '{}'::jsonb, 0, %(now)s, deleted_at FROM moved
)
INSERT INTO memory_settings (user_id, enabled, updated_at)
SELECT user_id, FALSE, %(now)s FROM moved
ON CONFLICT (user_id) DO NOTHING
"""


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


@dataclass
class PurgeStats:
    """Сколько строк убрала физическая очистка: удалено из таблиц и обезличено в `model_usage`."""

    dialogs: int = 0
    messages: int = 0
    client_ids: int = 0
    memory_sources: int = 0
    voice_prefs: int = 0
    usage_anonymized: int = 0

    def add(self, other: "PurgeStats") -> None:
        for item in fields(self):
            setattr(self, item.name, getattr(self, item.name) + getattr(other, item.name))

    @property
    def total(self) -> int:
        return sum(getattr(self, item.name) for item in fields(self))


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
    `delete_dialog`, настройки и заметки памяти, очередь Cognee, `counts`, `checkpoint`
    (нет-оп, нужен `DialogStore`)."""

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
                moved = self._move_memory_deletions(conn)
            self._pool = pool
        except DialogDbError:
            raise
        except (psycopg.Error, PoolTimeout, OSError) as error:
            if pool is not None:
                pool.close()
            raise DialogDbError(f"{type(error).__name__}: {error}") from error
        dialogs, messages = self.counts()
        logger.info("dialog db opened postgres dialogs=%d messages=%d", dialogs, messages)
        if moved:
            logger.info("memory deletion marks moved to the cognee outbox count=%d", moved)

    @staticmethod
    def _move_memory_deletions(conn: psycopg.Connection) -> int:
        """Перенос меток `memory_deletions` агента 0.8.8 в очередь (`MEMORY_DELETIONS_TO_OUTBOX`). Таблицы нет (база заведена
        уже без неё) — переносить нечего. Возвращает, сколько меток перенесено."""
        if conn.execute("SELECT to_regclass('memory_deletions')").fetchone()[0] is None:
            return 0
        count = conn.execute("SELECT count(*) FROM memory_deletions").fetchone()[0]
        if count:
            conn.execute(MEMORY_DELETIONS_TO_OUTBOX, {"now": _now_iso()})
        return int(count)

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
        """Все диалоги человека (от старых к новым) с сообщениями и выбранный им голос. Мягко стёртое
        (`deleted_at`) не читается: для агента стёртого человека данных нет, физически их убирает очистка (`purge_dialogs`)."""
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
                    "memory_extracted_at FROM dialogs WHERE user_id = %s AND deleted_at IS NULL ORDER BY started_at, id",
                    (user_id,),
                )
            }
            for dialog_id, message_id, role, text, created_at, audio_seconds in conn.execute(
                "SELECT m.dialog_id, m.id, m.role, m.text, m.created_at, m.audio_seconds FROM messages m "
                "JOIN dialogs d ON d.id = m.dialog_id WHERE d.user_id = %s AND d.deleted_at IS NULL "
                "ORDER BY m.dialog_id, m.position",
                (user_id,),
            ).fetchall():
                dialogs[dialog_id].messages.append((message_id, role, text, created_at, audio_seconds))
            for dialog_id, client_id, message_id in conn.execute(
                "SELECT c.dialog_id, c.client_id, c.message_id FROM client_ids c "
                "JOIN dialogs d ON d.id = c.dialog_id WHERE d.user_id = %s AND d.deleted_at IS NULL",
                (user_id,),
            ).fetchall():
                dialogs[dialog_id].client_ids[client_id] = message_id
            pref = conn.execute(
                "SELECT voice FROM voice_prefs WHERE user_id = %s AND deleted_at IS NULL", (user_id,)
            ).fetchone()
        return list(dialogs.values()), (pref[0] if pref else None)

    def load_settings(self, user_id: str) -> bool | None:
        """«Подводить итог автоматически» человека; None, если он ещё ничего не выбирал (по умолчанию включено)."""
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT recap_enabled FROM dialog_settings WHERE user_id = %s", (user_id,)).fetchone()
        return None if row is None else bool(row[0])

    def save_settings(self, user_id: str, recap_enabled: bool) -> None:
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "INSERT INTO dialog_settings (user_id, recap_enabled, updated_at) VALUES (%s, %s, %s) "
                "ON CONFLICT (user_id) DO UPDATE SET recap_enabled = EXCLUDED.recap_enabled, updated_at = EXCLUDED.updated_at",
                (user_id, recap_enabled, datetime.now(UTC).isoformat(timespec="milliseconds")),
            )

    def expired_dialogs(self, cutoff: str) -> list[tuple[str, str]]:
        """(user_id, dialog_id) разговоров, чьё последнее сообщение (без сообщений — старт) старше `cutoff` (ISO, как в базе).
        Мягко удалённые (`deleted_at`) не возвращаются: иначе каждый проход «удалял» бы их заново."""
        with self._lock, self._connection() as conn:
            rows = conn.execute(
                "SELECT d.user_id, d.id FROM dialogs d WHERE d.deleted_at IS NULL AND COALESCE("
                "(SELECT MAX(m.created_at) FROM messages m WHERE m.dialog_id = d.id), d.started_at) < %s",
                (cutoff,),
            ).fetchall()
        return [(row[0], row[1]) for row in rows]

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
                # диалогов не трогает (это отметка бэкенда памяти о забранном диалоге). Мягко стёртый диалог
                # (deleted_at) запись не воскрешает: отложенная пачка не вернёт стёртого человека.
                cur.execute(
                    "INSERT INTO dialogs (id, user_id, started_at, ended_at, summary, greeting, voice, reply_index, "
                    "memory_mode, crisis_seen) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (id) DO UPDATE SET "
                    "ended_at = EXCLUDED.ended_at, summary = EXCLUDED.summary, greeting = EXCLUDED.greeting, "
                    "voice = EXCLUDED.voice, reply_index = EXCLUDED.reply_index, "
                    "crisis_seen = GREATEST(dialogs.crisis_seen, EXCLUDED.crisis_seen) "
                    "WHERE dialogs.deleted_at IS NULL",
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
                        "ON CONFLICT (user_id) DO UPDATE SET voice = EXCLUDED.voice "
                        "WHERE voice_prefs.deleted_at IS NULL",  # стёртый выбор голоса не воскрешает
                        clean_row(write.pref),
                    )

    def checkpoint(self) -> None:
        """Нет-оп: метод нужен контракту `DialogStore`; журнал транзакций ведёт кластер PostgreSQL."""

    def erase_user(self, user_id: str) -> None:
        """Мягко стереть всё о человеке одной транзакцией: диалоги и выбор голоса получают `deleted_at` (дочерние
        строки — сообщения, идентификаторы — остаются вместе с ними до очистки, расход обезличивается ею же), настройки памяти и разговоров, заметки, их
        отпечатки и операции очереди Cognee удаляются. Датасет Cognee к этому моменту уже удалён синхронно
        (`CogneeMemoryBackend.erase_user_data`, до ответа `204`). Идемпотентно: повтор не переписывает первые отметки. Для
        чтений человека больше нет (см. `load_user`)."""
        at = _now_iso()
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "UPDATE dialogs SET deleted_at = %s WHERE user_id = %s AND deleted_at IS NULL", (at, user_id)
            )
            conn.execute(
                "UPDATE voice_prefs SET deleted_at = %s WHERE user_id = %s AND deleted_at IS NULL", (at, user_id)
            )
            conn.execute("DELETE FROM memory_settings WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM dialog_settings WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM memory_notes WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM memory_outbox WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM memory_sources WHERE user_id = %s", (user_id,))

    def get_memory_settings(self, user_id: str) -> tuple[bool, str | None, str | None] | None:
        """Настройки памяти человека: (включена, версия согласия, когда). None — человек их ещё не задавал."""
        with self._lock, self._connection() as conn:
            row = conn.execute(
                "SELECT enabled, consent_version, consent_at FROM memory_settings WHERE user_id = %s", (user_id,)
            ).fetchone()
        return None if row is None else (bool(row[0]), row[1], row[2])

    # ─── заметки о человеке ───────────────────────────────────────────────────

    _NOTE_COLUMNS = "id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at"

    def list_notes(self, user_id: str) -> list[tuple[Any, ...]]:
        """Заметки человека, новые сверху: (id, kind, text, sensitive, event_date, dialog_id, created_at, updated_at)."""
        sql = f"SELECT {self._NOTE_COLUMNS} FROM memory_notes WHERE user_id = %s ORDER BY created_at DESC, id"
        with self._lock, self._connection() as conn:
            return [tuple(row) for row in conn.execute(sql, (user_id,)).fetchall()]

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
            conn.execute(
                "UPDATE memory_sources SET suppressed = TRUE WHERE user_id = %s AND note_id = %s", (user_id, note_id)
            )  # старая формулировка поправлена: её реплика больше не источник правды
            cursor = conn.execute(
                "UPDATE memory_notes SET text = %s, updated_at = %s WHERE id = %s AND user_id = %s",
                (clean(text), updated_at, note_id, user_id),
            )
            return cursor.rowcount > 0

    def delete_note(self, user_id: str, note_id: str) -> bool:
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("UPDATE memory_sources SET suppressed = TRUE WHERE user_id = %s AND note_id = %s", (user_id, note_id))
            return conn.execute("DELETE FROM memory_notes WHERE id = %s AND user_id = %s", (note_id, user_id)).rowcount > 0

    def delete_notes(self, user_id: str, only_sensitive: bool = False) -> int:
        sql = "DELETE FROM memory_notes WHERE user_id = %s" + (" AND sensitive" if only_sensitive else "")
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "UPDATE memory_sources SET suppressed = TRUE WHERE user_id = %s AND note_id IN "
                "(SELECT id FROM memory_notes WHERE user_id = %s" + (" AND sensitive" if only_sensitive else "") + ")",
                (user_id, user_id),
            )
            return conn.execute(sql, (user_id,)).rowcount

    def add_note_source(self, user_id: str, note_id: str, dialog_id: str, source_hash: str, created_at: str) -> None:
        """Запомнить отпечаток реплики, на которой выросла заметка."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "INSERT INTO memory_sources (note_id, user_id, dialog_id, hash, created_at) VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT DO NOTHING",
                (note_id, user_id, dialog_id, source_hash, created_at),
            )

    def source_dialogs(self, user_id: str, note_id: str | None = None, only_sensitive: bool = False) -> list[str]:
        """Разговоры-источники заметок: одной (`note_id`), чувствительных или всех заметок человека. Зовётся до удаления."""
        sql = (
            "SELECT DISTINCT s.dialog_id FROM memory_sources s JOIN memory_notes n ON n.id = s.note_id "
            "WHERE s.user_id = %s AND NOT s.suppressed"
        )
        args: list[Any] = [user_id]
        if note_id is not None:
            sql += " AND s.note_id = %s"
            args.append(note_id)
        elif only_sensitive:
            sql += " AND n.sensitive"
        with self._lock, self._connection() as conn:
            return [r[0] for r in conn.execute(sql, args).fetchall()]

    def suppressed_hashes(self, user_id: str, dialog_id: str | None = None) -> set[str]:
        """Отпечатки подавленных реплик человека (или одного разговора)."""
        sql = "SELECT hash FROM memory_sources WHERE user_id = %s AND suppressed"
        args: list[Any] = [user_id]
        if dialog_id is not None:
            sql += " AND dialog_id = %s"
            args.append(dialog_id)
        with self._lock, self._connection() as conn:
            return {r[0] for r in conn.execute(sql, args).fetchall()}

    def get_memory_flags(self, user_id: str) -> tuple[bool, bool]:
        """(запоминать чувствительное, опираться на прошлые разговоры); без строки — значения по умолчанию (False, True)."""
        with self._lock, self._connection() as conn:
            row = conn.execute(
                "SELECT sensitive_enabled, chat_search_enabled FROM memory_settings WHERE user_id = %s", (user_id,)
            ).fetchone()
        return (False, True) if row is None else (bool(row[0]), bool(row[1]))

    # ─── очередь операций Cognee (слой 2 памяти) ──────────────────────────────

    def outbox_add(self, user_id: str, op: str, payload: dict[str, Any], next_at: str, created_at: str) -> None:
        """Поставить операцию Cognee в очередь: `index_dialog`, `delete_document`, `delete_dataset`, `rebuild`."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute(
                "INSERT INTO memory_outbox (user_id, op, payload, attempts, next_at, created_at) VALUES (%s, %s, %s::jsonb, 0, %s, %s)",
                (user_id, op, json.dumps(payload, ensure_ascii=False), next_at, created_at),
            )

    def outbox_due(self, now: str, limit: int = 20) -> list[tuple[int, str, str, dict[str, Any], int]]:
        """Операции, которым пора: (id, user_id, op, payload, attempts), старые первыми."""
        with self._lock, self._connection() as conn:
            rows = conn.execute(
                "SELECT id, user_id, op, payload, attempts FROM memory_outbox WHERE next_at <= %s ORDER BY id LIMIT %s",
                (now, limit),
            ).fetchall()
        return [(int(r[0]), r[1], r[2], r[3] if isinstance(r[3], dict) else json.loads(r[3]), int(r[4])) for r in rows]

    def outbox_done(self, outbox_id: int) -> None:
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("DELETE FROM memory_outbox WHERE id = %s", (outbox_id,))

    def outbox_retry(self, outbox_id: int, attempts: int, next_at: str) -> None:
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("UPDATE memory_outbox SET attempts = %s, next_at = %s WHERE id = %s", (attempts, next_at, outbox_id))

    def outbox_pending(self) -> int:
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT count(*) FROM memory_outbox").fetchone()
        return int(row[0]) if row else 0

    def outbox_drop_user(self, user_id: str, ops: tuple[str, ...]) -> None:
        """Убрать из очереди операции человека (например, индексацию, когда индекс уже решили удалить целиком)."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("DELETE FROM memory_outbox WHERE user_id = %s AND op = ANY(%s)", (user_id, list(ops)))

    def get_cognee_data_id(self, dialog_id: str) -> str | None:
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT cognee_data_id FROM dialogs WHERE id = %s", (dialog_id,)).fetchone()
        return row[0] if row and row[0] else None

    def set_cognee_data_id(self, dialog_id: str, data_id: str | None) -> None:
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("UPDATE dialogs SET cognee_data_id = %s WHERE id = %s", (data_id, dialog_id))

    def clear_cognee_data_ids(self, user_id: str) -> None:
        """Индекс человека в Cognee удалён целиком: ни у одного его разговора больше нет документа."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("UPDATE dialogs SET cognee_data_id = NULL WHERE user_id = %s", (user_id,))

    def dialog_for_index(self, dialog_id: str) -> tuple[str, str, str, list[tuple[str, str]]] | None:
        """Разговор для индексации: (user_id, started_at, memory_mode, [(role, text)]) или None, если его уже нет или он мягко
        удалён: удалённое в индекс не возвращается."""
        with self._lock, self._connection() as conn:
            head = conn.execute(
                "SELECT user_id, started_at, memory_mode FROM dialogs WHERE id = %s AND deleted_at IS NULL", (dialog_id,)
            ).fetchone()
            if head is None:
                return None
            rows = conn.execute("SELECT role, text FROM messages WHERE dialog_id = %s ORDER BY position", (dialog_id,)).fetchall()
        return head[0], head[1], head[2], [(r[0], r[1]) for r in rows]

    def indexable_dialog_ids(self, user_id: str) -> list[str]:
        """Завершённые разговоры человека, которые идут в индекс: не «не сохранять», по порядку (для пересборки индекса)."""
        with self._lock, self._connection() as conn:
            rows = conn.execute(
                "SELECT id FROM dialogs WHERE user_id = %s AND ended_at IS NOT NULL AND memory_mode = 'on' AND deleted_at IS NULL "
                "ORDER BY started_at",
                (user_id,),
            ).fetchall()
        return [r[0] for r in rows]

    def get_notes_cursor(self, dialog_id: str) -> int:
        """Сколько реплик человека в разговоре уже отдано извлекателю заметок (0 — ни одной или разговора нет в базе)."""
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT memory_notes_cursor FROM dialogs WHERE id = %s", (dialog_id,)).fetchone()
        try:
            return int(row[0]) if row and row[0] is not None else 0
        except ValueError:
            return 0

    def set_notes_cursor(self, dialog_id: str, cursor: int) -> None:
        """Запомнить, сколько реплик человека уже разобрано: после перезапуска агента разбор продолжится с этого места."""
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("UPDATE dialogs SET memory_notes_cursor = %s WHERE id = %s", (str(cursor), dialog_id))

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
        """Мягко удалить один диалог человека: сообщения и идентификаторы остаются вместе с ним до очистки, отпечатки его реплик
        (`memory_sources`) удаляются. Документ разговора в Cognee к этому моменту поставлен в очередь (`dialog_deleting`).

        `forget_derived` принимается ради контракта: заметки из разговора остаются (`add-memory-notes`, D10). Идемпотентно:
        повтор не переписывает первую отметку.
        """
        with self._lock, self._connection() as conn, conn.transaction():
            conn.execute("DELETE FROM memory_sources WHERE dialog_id = %s AND user_id = %s", (dialog_id, user_id))
            conn.execute(
                "UPDATE dialogs SET deleted_at = %s "
                "WHERE id = %s AND user_id = %s AND deleted_at IS NULL",
                (_now_iso(), dialog_id, user_id),
            )

    # ─── физическая очистка мягко стёртого (PROTEUS-255) ──────────────────────

    def purge_dialogs(self, cutoff: str, limit: int) -> PurgeStats:
        """Физически убрать до `limit` диалогов, помеченных стёртыми раньше `cutoff` (ISO, как в базе), одной короткой транзакцией:
        сообщения, идентификаторы клиента и отпечатки реплик удаляются вместе с диалогом, а строки расхода остаются без связи
        с ним (`dialog_id` и `message_id` — NULL; модель, количество и время сохраняются).

        `FOR UPDATE SKIP LOCKED` делает проход безопасным при нескольких исполнителях: каждый берёт свою пачку, чужую не ждёт и не
        удаляет повторно, а счётчики считают только то, что удалила эта транзакция. Повторный вызов на том же наборе вернёт нули."""
        with self._lock, self._connection() as conn, conn.transaction():
            ids = [
                row[0]
                for row in conn.execute(
                    "SELECT id FROM dialogs WHERE deleted_at < %s ORDER BY deleted_at LIMIT %s FOR UPDATE SKIP LOCKED",
                    (cutoff, limit),
                ).fetchall()
            ]
            if not ids:
                return PurgeStats()
            stats = PurgeStats()
            stats.usage_anonymized = conn.execute(
                "UPDATE model_usage SET dialog_id = NULL, message_id = NULL WHERE dialog_id = ANY(%s)", (ids,)
            ).rowcount
            stats.memory_sources = conn.execute("DELETE FROM memory_sources WHERE dialog_id = ANY(%s)", (ids,)).rowcount
            stats.client_ids = conn.execute("DELETE FROM client_ids WHERE dialog_id = ANY(%s)", (ids,)).rowcount
            stats.messages = conn.execute("DELETE FROM messages WHERE dialog_id = ANY(%s)", (ids,)).rowcount
            stats.dialogs = conn.execute("DELETE FROM dialogs WHERE id = ANY(%s)", (ids,)).rowcount
            return stats

    def purge_voice_prefs(self, cutoff: str, limit: int) -> int:
        """Физически убрать до `limit` строк выбора голоса, помеченных стёртыми раньше `cutoff`. Возвращает, сколько убрано."""
        with self._lock, self._connection() as conn, conn.transaction():
            return conn.execute(
                "DELETE FROM voice_prefs WHERE user_id IN ("
                "SELECT user_id FROM voice_prefs WHERE deleted_at < %s ORDER BY deleted_at LIMIT %s FOR UPDATE SKIP LOCKED)",
                (cutoff, limit),
            ).rowcount

    def marked_counts(self, cutoff: str) -> tuple[int, int]:
        """Сколько строк помечено стёртыми раньше `cutoff` и ещё лежит в базе: (диалоги, выбор голоса)."""
        with self._lock, self._connection() as conn:
            row = conn.execute(
                "SELECT (SELECT count(*) FROM dialogs WHERE deleted_at < %(cutoff)s), "
                "(SELECT count(*) FROM voice_prefs WHERE deleted_at < %(cutoff)s)",
                {"cutoff": cutoff},
            ).fetchone()
        return int(row[0]), int(row[1])
