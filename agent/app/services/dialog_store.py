"""Диалоги: рабочий набор в памяти процесса и копия на диске.

Весь код агента работает с `Message`/`Dialog` в памяти, как раньше. Если задан `DIALOG_DB_PATH`, хранилище подключает файл SQLite
(`attach`, app/services/dialog_db.py): изменения дописываются в фоне, а диалоги человека загружаются с диска при первом обращении
(`ensure_user`), поэтому они переживают перезапуск и выкат пода. Без файла хранилище, как раньше, только в памяти.
Настоящая БД агента (design D6) подставляется на место `DialogDatabase`, интерфейс хранилища остаётся тем же.

С диском память пода не растёт с числом людей бесконечно: давно неактивные выгружаются (`evict_idle`), а при следующем обращении
`ensure_user` загружает их диалоги снова. Источник данных при этом по-прежнему память: выгружается только то, что уже лежит на диске.

Запись устроена так, чтобы не трогать места, где код меняет сообщения на месте (ответ дописывается по словам):
фоновая запись раз в `flush_interval` сравнивает диалоги, изменённые через хранилище или имеющие живой сокет, с тем, что уже
записано, и пишет разницу одной транзакцией.
"""

import asyncio
import base64
import binascii
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from app.clients.speech import Voice
from app.core.metrics import (
    DIALOG_DB_ERRORS_TOTAL,
    DIALOG_DB_WRITE_SECONDS,
    DIALOG_DIALOGS_IN_MEMORY,
    DIALOG_EVICTIONS_SKIPPED_TOTAL,
    DIALOG_EVICTIONS_TOTAL,
    DIALOG_LOAD_SECONDS,
    DIALOG_LOADS_TOTAL,
    DIALOG_MESSAGES_IN_MEMORY,
    DIALOG_USERS_IN_MEMORY,
)
from app.services.dialog_db import DialogDatabase, DialogDbError, DialogWrite, StoredDialog, encode_summary

logger = logging.getLogger("agent.dialogs")

# Потолок числа людей в памяти не выгружает тех, кто обращался за последнюю минуту: между стартом разговора и его сокетом
# проходят секунды, и приветствие (оно только в памяти) не должно теряться из-за наплыва других людей.
CAP_MIN_IDLE_SECONDS = 60.0
# Кого уже выгружали (только для метрики first/reload). Сверх этого множество очищается: дешевле ошибиться в метрике, чем копить.
EVICTED_MEMO_LIMIT = 100_000

GREETING_NEW = "Я рядом. С чего начнём?"
GREETING_RESUMED = "Продолжим, где остановились."
GREETINGS = (GREETING_NEW, GREETING_RESUMED)


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Message:
    id: str
    role: str  # "user" | "assistant"
    text: str
    created_at: str

    def to_json(self) -> dict[str, str]:
        return {"id": self.id, "role": self.role, "text": self.text, "createdAt": self.created_at}


@dataclass
class Dialog:
    id: str
    user_id: str
    started_at: str
    ended_at: str | None = None
    summary: dict[str, Any] | None = None
    messages: list[Message] = field(default_factory=list)
    greeting: str | None = None
    # Приветствие озвучивается один раз на каждый POST …/dialogs, на первом сокете после него.
    greeting_pending: bool = False
    # id реплик клиента → id сообщения: повтор без ack не создаёт второго сообщения.
    client_ids: dict[str, str] = field(default_factory=dict)
    reply_index: int = 0
    # Голос озвучки этого диалога (род): задаётся при старте или кадром set_voice.
    voice: Voice = "male"
    # Один живой сокет на диалог (specs/agent-api «Обрыв и переподключение»).
    has_live_socket: bool = False
    # Зовёт хранилище, когда диалог завершён снаружи сокета (человек начал новый разговор с другого экрана): сокет сообщает
    # `ended` и закрывается, а не продолжает писать в завершённый диалог. Ставит и снимает сессия; на диск не попадает.
    on_replaced: Callable[[dict[str, Any]], None] | None = field(default=None, repr=False, compare=False)

    def to_item(self) -> dict[str, Any]:
        return {"dialogId": self.id, "startedAt": self.started_at, "endedAt": self.ended_at, "summary": self.summary}

    @property
    def last_activity_at(self) -> str | None:
        """Когда в диалоге что-то происходило в последний раз: завершение или последнее сообщение; у пустого открытого None."""
        if self.ended_at:
            return self.ended_at
        return self.messages[-1].created_at if self.messages else None


class InvalidCursor(ValueError):
    pass


def _encode_cursor(dialog: Dialog) -> str:
    raw = f"{dialog.started_at}|{dialog.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        started_at, dialog_id = raw.split("|", 1)
    except (binascii.Error, UnicodeDecodeError, ValueError) as error:
        raise InvalidCursor(cursor) from error
    return started_at, dialog_id


@dataclass
class _Persisted:
    """Что по диалогу уже лежит на диске: следующая запись берёт только разницу."""

    row: tuple[Any, ...]
    messages: dict[str, str] = field(default_factory=dict)  # id сообщения → текст
    client_ids: int = 0


class DialogStore:
    def __init__(self, default_voice: Voice = "male", idle_evict_seconds: float = 0, max_users_in_memory: int = 0) -> None:
        """`idle_evict_seconds` и `max_users_in_memory` — выгрузка неактивных (`evict_idle`): срок простоя и мягкий потолок числа
        людей в памяти; 0 — выключено. Работает только с подключённым диском."""
        self._users: dict[str, dict[str, Dialog]] = {}
        self._default_voice = default_voice
        # Последний выбор голоса человека: следующий диалог без явного голоса получит его.
        self._voice_prefs: dict[str, Voice] = {}
        self._last_started: datetime | None = None
        # Диск. Всё ниже, кроме _db, нужно только при подключённой базе.
        self._db: DialogDatabase | None = None
        # Диск задан в настройках: пока он не подключён, стирание человека не может честно ответить «стёрто».
        self._disk_required = False
        self._flush_interval = 0.5
        self._loaded: set[str] = set()
        # Выгрузка неактивных: когда к человеку обращались в последний раз (time.monotonic) и кого уже выгружали.
        self._idle_evict_seconds = idle_evict_seconds
        self._max_users_in_memory = max_users_in_memory
        self._last_access: dict[str, float] = {}
        self._evicted: set[str] = set()
        self._load_lock = asyncio.Lock()
        self._flush_lock = asyncio.Lock()
        self._dirty: dict[str, Dialog] = {}
        self._watch: dict[str, Dialog] = {}  # диалоги с живым сокетом: их сообщения дописываются на месте
        self._persisted: dict[str, _Persisted] = {}
        self._persisted_prefs: dict[str, str] = {}
        self._wake = asyncio.Event()
        self._writer: asyncio.Task[None] | None = None

    # ─── время ────────────────────────────────────────────────────────────────

    def _next_started_at(self) -> str:
        """Время старта диалога, строго возрастающее: журнал сортируется по нему, а два диалога в одну миллисекунду
        иначе упорядочились бы по случайному uuid."""
        now = datetime.now(UTC)
        now = now.replace(microsecond=now.microsecond // 1000 * 1000)  # сравниваем с точностью строки: до миллисекунды
        if self._last_started is not None and now <= self._last_started:
            now = self._last_started + timedelta(milliseconds=1)
        self._last_started = now
        return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    # ─── диалоги ──────────────────────────────────────────────────────────────

    def _dialogs(self, user_id: str) -> dict[str, Dialog]:
        return self._users.setdefault(user_id, {})

    def get(self, user_id: str, dialog_id: str) -> Dialog | None:
        """Чужой и несуществующий диалог неразличимы: оба дают None."""
        return self._users.get(user_id, {}).get(dialog_id)

    def open_dialog(self, user_id: str) -> Dialog | None:
        return next((d for d in self._dialogs(user_id).values() if d.ended_at is None), None)

    def start(self, user_id: str, voice: Voice | None = None, new: bool = False) -> tuple[Dialog, bool, int | None]:
        """Начать или возобновить диалог. Возвращает (диалог, resumed, часов с прошлого разговора).

        `voice` — выбранный голос: запоминается как предпочтение человека; без него берётся прошлый выбор или голос по умолчанию.
        `new` — начать новый разговор вместо возврата в открытый: открытый, если в нём есть сообщения, завершается так же, как
        обычное завершение без слов человека (название по его первой реплике), остаётся в журнале, а его сокет получает `ended`.
        Открытый диалог без сообщений и так «новый»: он переиспользуется, `resumed` ложь. Без `new` старт идемпотентен:
        открытый диалог возвращается с `resumed`, ничего не меняется.
        """
        hours = self._hours_since_last(user_id)  # до завершения открытого: от последней активности человека, в том числе в нём
        existing = self.open_dialog(user_id)
        resumed = existing is not None
        if new and existing is not None:
            resumed = False
            if existing.messages:
                summary = self.end(existing, None, None)
                if existing.on_replaced is not None:
                    existing.on_replaced(summary)
                existing = None
            # пустой открытый диалог: нечего ни завершать, ни продолжать, он остаётся и приветствует как новый
        dialog = existing or Dialog(id=str(uuid.uuid4()), user_id=user_id, started_at=self._next_started_at())
        self._dialogs(user_id)[dialog.id] = dialog
        if voice is not None:
            self._voice_prefs[user_id] = voice
        dialog.voice = voice or self._voice_prefs.get(user_id) or self._default_voice
        dialog.greeting = GREETING_RESUMED if resumed else GREETING_NEW
        dialog.greeting_pending = True
        self._touch(dialog)
        return dialog, resumed, hours

    def _hours_since_last(self, user_id: str) -> int | None:
        """Часов с последней активности человека: завершение прошлого разговора или последнее сообщение в открытом."""
        stamps = [d.last_activity_at for d in self._dialogs(user_id).values()]
        stamps = [s for s in stamps if s]
        if not stamps:
            return None
        last = datetime.fromisoformat(max(stamps).replace("Z", "+00:00"))
        return round((datetime.now(UTC) - last).total_seconds() / 3600)

    def list(self, user_id: str, limit: int, before: str | None) -> tuple[list[Dialog], str | None]:
        """Журнал от новых к старым. `before` принимает только значение из прошлого `next`."""
        ordered = sorted(self._dialogs(user_id).values(), key=lambda d: (d.started_at, d.id), reverse=True)
        if before is not None:
            bound = _decode_cursor(before)
            ordered = [d for d in ordered if (d.started_at, d.id) < bound]
        page = ordered[:limit]
        has_more = len(ordered) > limit
        return page, (_encode_cursor(page[-1]) if has_more and page else None)

    def set_voice(self, dialog: Dialog, voice: Voice) -> None:
        """Сменить голос идущего диалога; запоминается и как предпочтение человека."""
        dialog.voice = voice
        self._voice_prefs[dialog.user_id] = voice
        self._touch(dialog)

    def add_message(self, dialog: Dialog, role: str, text: str, message_id: str | None = None) -> Message:
        message = Message(id=message_id or str(uuid.uuid4()), role=role, text=text, created_at=now_iso())
        dialog.messages.append(message)
        self._touch(dialog)
        return message

    def end(self, dialog: Dialog, takeaway: str | None, tension_after: int | None) -> dict[str, Any]:
        """Завершить диалог. Повторный вызов отдаёт ту же сводку."""
        if dialog.summary is not None:
            return dialog.summary
        first_user = next((m for m in dialog.messages if m.role == "user"), None)
        title = (takeaway or (first_user.text if first_user else "") or "Разговор")[:80]
        dialog.ended_at = now_iso()
        dialog.summary = {
            "title": title,
            # Темы настоящий агент выводит сам; пока одна и та же.
            "themes": ["выговориться"],
            "tensionBefore": None,
            "tensionAfter": tension_after,
        }
        self._touch(dialog)
        return dialog.summary

    def erase_user(self, user_id: str) -> None:
        """Стереть всё о человеке в памяти. Идемпотентно. На диске стирает `erase_user_durable`."""
        self._last_access.pop(user_id, None)  # без отметки выгрузка его не трогает: отметку загрузки снимает стирание на диске
        self._evicted.discard(user_id)
        for dialog_id in self._users.pop(user_id, {}):
            self._dirty.pop(dialog_id, None)
            self._watch.pop(dialog_id, None)
            self._persisted.pop(dialog_id, None)
        self._voice_prefs.pop(user_id, None)
        self._persisted_prefs.pop(user_id, None)

    # ─── диск ─────────────────────────────────────────────────────────────────

    @property
    def persistent(self) -> bool:
        return self._db is not None

    def require_disk(self) -> None:
        """Диск задан в настройках (`DIALOG_DB_PATH`). Если подключиться к нему не удалось, стирание человека отвечает ошибкой: файл
        на томе при этом остаётся нетронутым, и приложение не должно считать данные стёртыми."""
        self._disk_required = True

    async def attach(self, db: DialogDatabase, flush_interval: float = 0.5) -> None:
        """Подключить диск: открыть базу и запустить фоновую запись. Если база не открылась, исключение уходит вызывающему,
        а хранилище остаётся в памяти."""
        await asyncio.to_thread(db.open)
        self._db = db
        self._flush_interval = flush_interval
        self._writer = asyncio.create_task(self._write_loop(), name="dialog-db-writer")

    async def detach(self) -> None:
        """Остановить фоновую запись, дописать всё несохранённое и закрыть базу."""
        db = self._db
        if db is None:
            return
        if self._writer is not None:
            self._writer.cancel()
            await asyncio.gather(self._writer, return_exceptions=True)
            self._writer = None
        # Всё, что ещё меняется на месте (идущие ответы), тоже попадает в последнюю запись.
        self._dirty.update(self._watch)
        await self.flush()
        self._db = None
        await asyncio.to_thread(db.close)

    async def ensure_user(self, user_id: str) -> None:
        """Загрузить диалоги человека с диска, если это ещё не сделано. Вызывать в начале каждого обращения по человеку.

        Сбой чтения — исключение: лучше ответить ошибкой, чем показать человеку пустую историю и начать второй открытый диалог.
        Выгруженный (`evict_idle`) человек загружается так же, как после перезапуска. Загруженный возвращается без await: диалог,
        взятый сразу после вызова, принадлежит хранилищу, выгрузка между ними не вклинится.
        """
        db = self._db
        if db is None:
            return
        if user_id in self._loaded:
            self._last_access[user_id] = time.monotonic()  # обращение: простой для выгрузки считается от него
            return
        async with self._load_lock:
            if user_id in self._loaded:
                self._last_access[user_id] = time.monotonic()  # его загрузил другой запрос, пока этот ждал замка
                return
            started = time.monotonic()
            try:
                stored, pref = await asyncio.to_thread(db.load_user, user_id)
            except Exception:
                DIALOG_DB_ERRORS_TOTAL.labels("load").inc()
                logger.exception("dialog db load failed user=%s", user_id)
                raise
            dialogs = self._dialogs(user_id)
            for item in stored:
                if item.id in dialogs:
                    continue
                dialogs[item.id] = self._from_stored(item)
                self._persisted[item.id] = self._snapshot_of(dialogs[item.id])
            if pref in ("male", "female") and user_id not in self._voice_prefs:
                self._voice_prefs[user_id] = pref  # type: ignore[assignment]
            if pref:
                self._persisted_prefs[user_id] = pref
            DIALOG_LOAD_SECONDS.observe(time.monotonic() - started)
            DIALOG_LOADS_TOTAL.labels("reload" if user_id in self._evicted else "first").inc()
            self._evicted.discard(user_id)
            # Отметка обращения ставится только у загруженного: сбой чтения не оставляет следа, а идущая загрузка выгрузке не видна.
            self._last_access[user_id] = time.monotonic()
            self._loaded.add(user_id)
            if stored:
                logger.info("dialog db loaded user=%s dialogs=%d", user_id, len(stored))

    @staticmethod
    def _from_stored(item: StoredDialog) -> Dialog:
        return Dialog(
            id=item.id,
            user_id=item.user_id,
            started_at=item.started_at,
            ended_at=item.ended_at,
            summary=item.summary,
            messages=[Message(id=m[0], role=m[1], text=m[2], created_at=m[3]) for m in item.messages],
            greeting=item.greeting,
            client_ids=dict(item.client_ids),
            reply_index=item.reply_index,
            voice=item.voice if item.voice in ("male", "female") else "male",  # type: ignore[arg-type]
        )

    @staticmethod
    def _row_of(dialog: Dialog) -> tuple[Any, ...]:
        return (
            dialog.id,
            dialog.user_id,
            dialog.started_at,
            dialog.ended_at,
            encode_summary(dialog.summary),
            dialog.greeting,
            dialog.voice,
            dialog.reply_index,
        )

    def _snapshot_of(self, dialog: Dialog) -> _Persisted:
        return _Persisted(
            row=self._row_of(dialog),
            messages={m.id: m.text for m in dialog.messages},
            client_ids=len(dialog.client_ids),
        )

    def _owns(self, dialog: Dialog) -> bool:
        return self._users.get(dialog.user_id, {}).get(dialog.id) is dialog

    def _touch(self, dialog: Dialog) -> None:
        """Диалог изменён через хранилище: записать в ближайший тик. Стёртый человек на диск не возвращается, а устаревший объект
        (человека выгрузили и загрузили заново) не перезаписывает свежий: держать диалог через await может только живой сокет,
        а человека с живым сокетом не выгружают."""
        if self._db is None or not self._owns(dialog):
            return
        self._dirty[dialog.id] = dialog
        self._last_access[dialog.user_id] = time.monotonic()
        self._wake.set()

    def socket_opened(self, dialog: Dialog) -> None:
        """У диалога живой сокет: ответы дописываются на месте, поэтому он сохраняется по таймеру, пока сокет жив."""
        dialog.has_live_socket = True
        if self._db is not None and self._owns(dialog):
            self._watch[dialog.id] = dialog
            self._wake.set()

    def socket_closed(self, dialog: Dialog) -> None:
        dialog.has_live_socket = False
        self._watch.pop(dialog.id, None)
        self._touch(dialog)

    def _collect(self, dialog: Dialog) -> DialogWrite | None:
        """Что в диалоге изменилось с прошлой записи; None, если ничего."""
        known = self._persisted.get(dialog.id)
        row = self._row_of(dialog)
        messages = [
            (m.id, dialog.id, position, m.role, m.text, m.created_at)
            for position, m in enumerate(dialog.messages)
            if known is None or known.messages.get(m.id) != m.text
        ]
        client_ids = (
            [(dialog.id, client_id, message_id) for client_id, message_id in dialog.client_ids.items()]
            if known is None or known.client_ids != len(dialog.client_ids)
            else []
        )
        pref = self._voice_prefs.get(dialog.user_id)
        pref_changed = pref is not None and self._persisted_prefs.get(dialog.user_id) != pref
        if known is not None and known.row == row and not messages and not client_ids and not pref_changed:
            return None
        return DialogWrite(
            dialog_id=dialog.id,
            row=row,
            messages=messages,
            client_ids=client_ids,
            pref=(dialog.user_id, pref) if pref_changed and pref is not None else None,
        )

    async def flush(self) -> bool:
        """Записать на диск всё, что изменилось. True, если записано (или писать нечего)."""
        if self._db is None:
            return True
        async with self._flush_lock:
            db = self._db
            if db is None:
                return True
            batch = {**self._dirty, **self._watch}
            self._dirty.clear()
            writes: list[tuple[Dialog, DialogWrite, _Persisted]] = []
            try:
                for dialog in batch.values():
                    if not self._owns(dialog):
                        continue
                    write = self._collect(dialog)
                    if write is not None:
                        writes.append((dialog, write, self._snapshot_of(dialog)))
            except Exception:
                self._dirty.update(batch)  # сбой при подготовке записи не должен выбрасывать диалоги из очереди
                raise
            if not writes:
                return True
            started = time.monotonic()
            try:
                await asyncio.to_thread(db.apply, [write for _, write, _ in writes])
                done, failed = writes, []
            except Exception:
                DIALOG_DB_ERRORS_TOTAL.labels("write").inc()
                logger.exception("dialog db write failed dialogs=%d: retrying one by one", len(writes))
                # Один «ядовитый» диалог не должен останавливать запись всем остальным: повторяем по одному.
                done, failed = [], []
                for item in writes:
                    try:
                        await asyncio.to_thread(db.apply, [item[1]])
                        done.append(item)
                    except Exception:
                        DIALOG_DB_ERRORS_TOTAL.labels("write").inc()
                        logger.exception("dialog db write failed dialog=%s: will retry", item[0].id)
                        failed.append(item)
            DIALOG_DB_WRITE_SECONDS.observe(time.monotonic() - started)
            for dialog, write, snapshot in done:
                if self._owns(dialog):  # человека могли стереть, пока шла запись
                    self._persisted[dialog.id] = snapshot
                    if write.pref is not None:
                        self._persisted_prefs[write.pref[0]] = write.pref[1]
            for dialog, _, _ in failed:
                self._dirty[dialog.id] = dialog
            return not failed

    async def _write_loop(self) -> None:
        backoff = 0.0
        while True:
            if not (self._dirty or self._watch):
                self._wake.clear()
                await self._wake.wait()
            await asyncio.sleep(self._flush_interval + backoff)
            try:
                ok = await self.flush()
            except asyncio.CancelledError:
                raise
            except Exception:  # писатель не должен умирать: без него диалоги больше не попадают на диск
                DIALOG_DB_ERRORS_TOTAL.labels("write").inc()
                logger.exception("dialog db writer iteration failed")
                ok = False
            backoff = 0.0 if ok else min((backoff * 2) or 1.0, 30.0)

    async def erase_user_durable(self, user_id: str) -> None:
        """Стереть всё о человеке в памяти и на диске. Идемпотентно. Исключение при сбое диска или если диск задан, но не подключён:
        вызывающий (приложение) не должен считать данные стёртыми и может повторить."""
        async with self._load_lock:  # не стирать посреди загрузки того же человека: прочитанное с диска иначе вернулось бы в память
            self.erase_user(user_id)
            db = self._db
            if db is None:
                if self._disk_required:
                    DIALOG_DB_ERRORS_TOTAL.labels("erase").inc()
                    raise DialogDbError("хранилище диалогов недоступно: стереть данные на диске сейчас нельзя")
                return
            async with self._flush_lock:  # ждём идущую запись, чтобы она не вернула стёртое
                try:
                    await asyncio.to_thread(db.erase_user, user_id)
                except Exception:
                    DIALOG_DB_ERRORS_TOTAL.labels("erase").inc()
                    logger.exception("dialog db erase failed user=%s", user_id)
                    raise
            self._loaded.discard(user_id)
            # Обращение посреди стирания могло снова поставить отметку, а выгрузка — запомнить человека: стёртого не помним.
            self._last_access.pop(user_id, None)
            self._evicted.discard(user_id)

    # ─── выгрузка неактивных ──────────────────────────────────────────────────

    def evict_idle(self, now: float) -> int:
        """Выгрузить из памяти людей, к которым давно не обращались. Возвращает, сколько выгружено. `now` — `time.monotonic()`.

        Их диалоги уже лежат на диске, и при следующем обращении `ensure_user` загрузит их, как после перезапуска. Проход
        синхронный, без await: пока он идёт, обработчики стоят, и ни один не окажется между `ensure_user` и работой с диалогом.

        Выгружается тот, кто молчит дольше `idle_evict_seconds`, а сверх потолка `max_users_in_memory` — самые давние (кроме
        обращавшихся за последнюю минуту). Человек остаётся в памяти, если:
        - диска нет (`attach` не было или не удалось): выгружать некуда;
        - он не загружен с диска (`ensure_user` его не загружал): загрузка ещё идёт, или его стирают;
        - у его диалога живой сокет: сессия держит объект диалога и меняет его на месте (`socket`);
        - есть незаписанное: диалог ждёт записи, запись идёт или не удалась, его изменили на месте после записи, выбор голоса не
          записан (`dirty`). Изменённое на месте без очереди ставится в очередь: человек выгрузится на следующем проходе.
        Неозвученное приветствие (`greeting_pending`) живёт только в памяти и при выгрузке теряется: если сокет откроется позже
        срока, приветствие не прозвучит, клиент прочтёт его сам (как при обрыве озвучки).

        Заодно обновляет метрики памяти (`agent_dialog_*_in_memory`), и без диска тоже.
        """
        evicted = 0
        ttl, cap = self._idle_evict_seconds, self._max_users_in_memory
        if self._db is not None and (ttl or cap):
            # От давних к свежим. Без отметки обращения — стирание идёт или не удалось: такого не трогаем.
            order = sorted((at, user_id) for user_id, at in self._last_access.items() if user_id in self._loaded)
            in_memory = len(self._loaded)
            for at, user_id in order:
                expired = bool(ttl) and now - at >= ttl
                over_cap = bool(cap) and in_memory > cap and now - at >= CAP_MIN_IDLE_SECONDS
                if not (expired or over_cap):
                    break  # дальше только те, кто обращался позже
                reason = self._keeps(user_id)
                if reason is not None:
                    DIALOG_EVICTIONS_SKIPPED_TOTAL.labels(reason).inc()
                    continue
                self._unload(user_id)
                in_memory -= 1
                evicted += 1
            if evicted:
                DIALOG_EVICTIONS_TOTAL.inc(evicted)
                logger.info("dialog users evicted count=%d in_memory=%d", evicted, in_memory)
        self._report_memory()
        return evicted

    def _keeps(self, user_id: str) -> str | None:
        """Почему человека сейчас нельзя выгрузить: `socket` или `dirty` (см. `evict_idle`); None — можно."""
        dialogs = list(self._users.get(user_id, {}).values())
        if any(d.has_live_socket or d.on_replaced is not None or d.id in self._watch for d in dialogs):
            return "socket"
        dirty = False
        for dialog in dialogs:
            if dialog.id in self._dirty:
                dirty = True
            elif self._collect(dialog) is not None:
                # Изменён на месте без `_touch` или его запись идёт прямо сейчас: снимок записанного отстаёт от памяти.
                # Повторная запись того же безвредна, а изменённое на месте иначе дождалось бы только остановки пода.
                self._dirty[dialog.id] = dialog
                self._wake.set()
                dirty = True
        pref = self._voice_prefs.get(user_id)
        if pref is not None and self._persisted_prefs.get(user_id) != pref:
            dirty = True
        return "dirty" if dirty else None

    def _unload(self, user_id: str) -> None:
        """Убрать человека из памяти процесса. Всё, что убирается, есть на диске (проверил `_keeps`)."""
        for dialog_id in self._users.pop(user_id, {}):
            self._dirty.pop(dialog_id, None)
            self._watch.pop(dialog_id, None)
            self._persisted.pop(dialog_id, None)
        self._voice_prefs.pop(user_id, None)
        self._persisted_prefs.pop(user_id, None)
        self._loaded.discard(user_id)
        self._last_access.pop(user_id, None)
        if len(self._evicted) >= EVICTED_MEMO_LIMIT:
            self._evicted.clear()
        self._evicted.add(user_id)

    def _report_memory(self) -> None:
        DIALOG_USERS_IN_MEMORY.set(len(self._users.keys() | self._loaded))
        DIALOG_DIALOGS_IN_MEMORY.set(sum(len(dialogs) for dialogs in self._users.values()))
        DIALOG_MESSAGES_IN_MEMORY.set(sum(len(d.messages) for dialogs in self._users.values() for d in dialogs.values()))

    async def evict_loop(self, interval: float) -> None:
        """Фоновая выгрузка неактивных: `evict_idle` раз в `interval` секунд. Запускает и останавливает приложение (lifespan)."""
        while True:
            await asyncio.sleep(interval)
            try:
                self.evict_idle(time.monotonic())
            except Exception:  # noqa: BLE001 - проход не должен останавливать выгрузку: без неё память пода только растёт
                logger.exception("dialog eviction pass failed")
