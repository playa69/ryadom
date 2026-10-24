"""Диалоги в PostgreSQL (`DIALOG_DATABASE_URL`): единственное хранилище диалогов агента.

Рабочий набор остаётся в памяти (`DialogStore`): сюда он дублируется в фоне, отсюда по человеку загружается при первом
обращении. Реплика пода одна, `strategy: Recreate` оставляет одного писателя. В бою это база `agent` в CNPG
`ryadom-db` (k8s/agent/README.md «Хранилище диалогов»).

`DialogStore` зовёт базу синхронно, через `asyncio.to_thread`, по одному обращению под замком. Драйвер psycopg3
синхронный: асинхронный здесь ничего не дал бы, а зависимостей и кода было бы больше. Соединение в
`autocommit=True`: `conn.transaction()` тогда сам делает BEGIN/COMMIT на записях, а чтения не оставляют за собой
висячую неявную транзакцию (иначе она держала бы блокировки, а записи через savepoint никогда не коммитились).

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
from dataclasses import dataclass, field
from typing import Any, Callable, TypeVar

import psycopg

logger = logging.getLogger("agent.db")

_T = TypeVar("_T")

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

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self._conn: psycopg.Connection | None = None
        self._lock = threading.Lock()

    def _connect(self) -> psycopg.Connection:
        # keepalives: сетевой слой (сайдкар, балансировщик) закрывает молчащие соединения; ядро тогда держит их живыми
        # и быстро замечает обрыв.
        return psycopg.connect(
            self.dsn,
            connect_timeout=10,
            application_name="agent",
            autocommit=True,
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=3,
        )

    def open(self) -> None:
        """Подключиться и гарантировать схему. Исключение — `DialogDbError`."""
        try:
            conn = self._connect()
            with conn.transaction():
                for statement in DDL:
                    conn.execute(statement)
            self._conn = conn
        except DialogDbError:
            raise
        except (psycopg.Error, OSError) as error:
            raise DialogDbError(f"{type(error).__name__}: {error}") from error
        dialogs, messages = self.counts()
        logger.info("dialog db opened postgres dialogs=%d messages=%d", dialogs, messages)

    def close(self) -> None:
        with self._lock:
            if self._conn is None:
                return
            self._conn.close()
            self._conn = None

    def _connection(self) -> psycopg.Connection:
        """Живое соединение. Закрытое или оборванное (сервер или сеть закрыли его) открывается заново: одно соединение
        на весь процесс не должно навсегда выводить агента из строя после первого разрыва."""
        if self._conn is None:
            raise DialogDbError("база диалогов не открыта")
        if self._conn.closed or self._conn.broken:
            self._reconnect()
        return self._conn

    def _reconnect(self) -> None:
        logger.warning("dialog db connection lost, reconnecting")
        try:
            self._conn.close()  # type: ignore[union-attr]
        except psycopg.Error:
            pass
        try:
            self._conn = self._connect()
        except (psycopg.Error, OSError) as error:
            raise DialogDbError(f"{type(error).__name__}: {error}") from error

    def _retrying(self, operation: Callable[[psycopg.Connection], _T]) -> _T:
        """Выполнить операцию под замком; если соединение оборвалось на ходу, переоткрыть его и повторить один раз.
        Повтор безопасен: записи идут одной транзакцией (оборвалась — откатилась), остальное — чтение или идемпотентное
        удаление."""
        with self._lock:
            try:
                return operation(self._connection())
            except (psycopg.OperationalError, psycopg.InterfaceError):
                self._reconnect()
                return operation(self._connection())

    def counts(self) -> tuple[int, int]:
        return self._retrying(
            lambda conn: (
                conn.execute("SELECT COUNT(*) FROM dialogs").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
            )
        )

    def load_user(self, user_id: str) -> tuple[list[StoredDialog], str | None]:
        """Все диалоги человека (от старых к новым) с сообщениями и выбранный им голос."""
        def read(conn: psycopg.Connection) -> tuple[list[StoredDialog], str | None]:
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

        return self._retrying(read)

    def apply(self, writes: list[DialogWrite]) -> None:
        """Записать пачку одной транзакцией: либо всё, либо ничего."""
        def write(conn: psycopg.Connection) -> None:
            with conn.cursor() as cur, conn.transaction():
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

        self._retrying(write)

    def checkpoint(self) -> None:
        """Нет-оп: метод нужен контракту `DialogStore`; журнал транзакций ведёт кластер PostgreSQL."""

    def erase_user(self, user_id: str) -> None:
        """Стереть всё о человеке (диалоги с сообщениями, расходом и идентификаторами — каскадом, выбор голоса) одной
        транзакцией. Идемпотентно. Память человека стирает бэкенд памяти (Cognee), здесь её таблиц нет."""

        def erase(conn: psycopg.Connection) -> None:
            with conn.transaction():
                conn.execute("DELETE FROM dialogs WHERE user_id = %s", (user_id,))
                conn.execute("DELETE FROM voice_prefs WHERE user_id = %s", (user_id,))

        self._retrying(erase)

    def delete_dialog(self, user_id: str, dialog_id: str, forget_derived: bool) -> None:
        """Удалить один диалог человека целиком (сообщения и расход уходят каскадом).

        `forget_derived` принимается ради контракта: фактами, выведенными из удалённого диалога, управляет бэкенд
        памяти (Cognee), а не хранилище диалогов.
        """

        def delete(conn: psycopg.Connection) -> None:
            with conn.transaction():
                conn.execute("DELETE FROM dialogs WHERE id = %s AND user_id = %s", (dialog_id, user_id))

        self._retrying(delete)
