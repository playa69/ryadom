"""Диалоги в памяти процесса.

Упрощение на этап проверки: данные исчезают при перезапуске и живут в одной реплике. Настоящее
хранилище (БД агента, design D6) подставляется на место этого класса, интерфейс останется тем же.
"""

import base64
import binascii
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.clients.speech import Voice


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

    def to_item(self) -> dict[str, Any]:
        return {"dialogId": self.id, "startedAt": self.started_at, "endedAt": self.ended_at, "summary": self.summary}


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


class DialogStore:
    def __init__(self, default_voice: Voice = "male") -> None:
        self._users: dict[str, dict[str, Dialog]] = {}
        self._default_voice = default_voice
        # Последний выбор голоса человека: следующий диалог без явного голоса получит его.
        self._voice_prefs: dict[str, Voice] = {}

    def _dialogs(self, user_id: str) -> dict[str, Dialog]:
        return self._users.setdefault(user_id, {})

    def get(self, user_id: str, dialog_id: str) -> Dialog | None:
        """Чужой и несуществующий диалог неразличимы: оба дают None."""
        return self._users.get(user_id, {}).get(dialog_id)

    def open_dialog(self, user_id: str) -> Dialog | None:
        return next((d for d in self._dialogs(user_id).values() if d.ended_at is None), None)

    def start(self, user_id: str, voice: Voice | None = None) -> tuple[Dialog, bool, int | None]:
        """Начать или возобновить диалог. Возвращает (диалог, resumed, часов с прошлого разговора).

        `voice` — выбранный голос: запоминается как предпочтение человека; без него берётся прошлый выбор или голос по умолчанию.
        """
        hours = self._hours_since_last(user_id)
        existing = self.open_dialog(user_id)
        dialog = existing or Dialog(id=str(uuid.uuid4()), user_id=user_id, started_at=now_iso())
        self._dialogs(user_id)[dialog.id] = dialog
        if voice is not None:
            self._voice_prefs[user_id] = voice
        dialog.voice = voice or self._voice_prefs.get(user_id) or self._default_voice
        dialog.greeting = "Продолжим, где остановились." if existing else "Я рядом. С чего начнём?"
        dialog.greeting_pending = True
        return dialog, existing is not None, hours

    def _hours_since_last(self, user_id: str) -> int | None:
        ended = [d.ended_at for d in self._dialogs(user_id).values() if d.ended_at]
        if not ended:
            return None
        last = datetime.fromisoformat(max(ended).replace("Z", "+00:00"))
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

    def add_message(self, dialog: Dialog, role: str, text: str) -> Message:
        message = Message(id=str(uuid.uuid4()), role=role, text=text, created_at=now_iso())
        dialog.messages.append(message)
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
        return dialog.summary

    def erase_user(self, user_id: str) -> None:
        """Стереть всё о человеке. Идемпотентно."""
        self._users.pop(user_id, None)
        self._voice_prefs.pop(user_id, None)
