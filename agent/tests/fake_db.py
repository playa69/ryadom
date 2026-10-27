"""In-memory двойник `DialogDatabase` для тестов: та же семантика без PostgreSQL и без файла (включая мягкое стирание).

Экземпляры с одинаковым `path` делят состояние — так тест «перезапуска пода» (новый `DialogStore` и новая база на том
же пути) видит записанное прежним. Тесты подменяют им настоящий класс:

    from tests.fake_db import FakeDialogDatabase as DialogDatabase

и наследуют заглушку в тестах сбоев (`class Flaky(DialogDatabase): ...`) — повторяются все проверки записи,
повторов и стирания из `DialogStore`. Состояние одного пути не переживает тест: фикстура `fake_files` (autouse)
чистит реестр.
"""

import json
import threading
from typing import Any

from app.services.dialog_db import DialogDbError, DialogWrite, StoredDialog


class _File:
    """«Файл»: строки таблиц одного пути."""

    def __init__(self) -> None:
        self.dialogs: dict[str, tuple] = {}  # id -> row (10 колонок, как DialogWrite.row + memory_extracted_at)
        self.messages: dict[tuple[str, str], tuple] = {}  # (dialog_id, id) -> row
        self.client_ids: dict[tuple[str, str], str] = {}  # (dialog_id, client_id) -> message_id
        self.prefs: dict[str, str] = {}  # user_id -> voice
        self.memory_settings: dict[str, tuple[bool, str | None, str | None]] = {}  # user_id -> (enabled, version, at)
        self.settings: dict[str, bool] = {}  # user_id -> recap_enabled
        self.usage: list[tuple] = []
        # Мягкое стирание, как deleted_at в PostgreSQL: строки остаются, чтения их не видят, запись не воскрешает.
        self.deleted_dialogs: set[str] = set()
        self.deleted_prefs: set[str] = set()
        self.memory_deletions: dict[str, str] = {}  # user_id -> отметка (метка для джобы удаления датасета Cognee)


class FakeDialogDatabase:
    label = "fake"
    _files: dict[str, _File] = {}
    _registry_lock = threading.Lock()

    def __init__(self, path: str) -> None:
        self.path = path
        self._file: _File | None = None
        self._lock = threading.Lock()

    @classmethod
    def reset(cls) -> None:
        with cls._registry_lock:
            cls._files = {}

    @classmethod
    def usage_rows(cls, path: str) -> list[tuple]:
        """Все строки расхода «файла» пути — для проверок тестов без открытия базы."""
        with cls._registry_lock:
            state = cls._files.get(path)
            return list(state.usage) if state is not None else []

    @classmethod
    def message_rows(cls, path: str) -> list[tuple]:
        """Все сообщения «файла» пути по порядку позиций."""
        with cls._registry_lock:
            state = cls._files.get(path)
            return sorted(state.messages.values(), key=lambda m: (m[1], m[2])) if state is not None else []

    def open(self) -> None:
        import os

        parent = os.path.dirname(self.path)
        if parent and os.path.exists(parent) and not os.path.isdir(parent):
            raise DialogDbError(f"родитель {parent} — не каталог")
        with self._registry_lock:
            self._file = self._files.setdefault(self.path, _File())

    def close(self) -> None:
        with self._lock:
            self._file = None

    def _state(self) -> _File:
        if self._file is None:
            raise DialogDbError("база диалогов не открыта")
        return self._file

    def counts(self) -> tuple[int, int]:
        with self._lock:
            state = self._state()
            return len(state.dialogs), len(state.messages)

    def load_user(self, user_id: str) -> tuple[list[StoredDialog], str | None]:
        with self._lock:
            state = self._state()
            dialogs = []
            for row in sorted(state.dialogs.values(), key=lambda r: (r[2], r[0])):
                if row[1] != user_id or row[0] in state.deleted_dialogs:
                    continue
                dialog_id = row[0]
                messages = [
                    (m[0], m[3], m[4], m[5], m[6])
                    for m in sorted(state.messages.values(), key=lambda m: (m[1], m[2]))
                    if m[1] == dialog_id
                ]
                client_ids = {cid: mid for (did, cid), mid in state.client_ids.items() if did == dialog_id}
                dialogs.append(
                    StoredDialog(
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
                        memory_extracted_at=row[10] if len(row) > 10 else None,
                        messages=messages,
                        client_ids=client_ids,
                    )
                )
            return dialogs, None if user_id in state.deleted_prefs else state.prefs.get(user_id)

    def load_settings(self, user_id: str) -> bool | None:
        with self._lock:
            return self._state().settings.get(user_id)

    def save_settings(self, user_id: str, recap_enabled: bool) -> None:
        with self._lock:
            self._state().settings[user_id] = recap_enabled

    def expired_dialogs(self, cutoff: str) -> list[tuple[str, str]]:
        with self._lock:
            state = self._state()
            result = []
            for dialog_id, row in state.dialogs.items():
                if dialog_id in state.deleted_dialogs:
                    continue
                stamps = [m[5] for m in state.messages.values() if m[1] == dialog_id]
                if (max(stamps) if stamps else row[2]) < cutoff:
                    result.append((row[1], dialog_id))
            return result

    def apply(self, writes: list[DialogWrite]) -> None:
        with self._lock:
            state = self._state()
            for write in writes:
                old = state.dialogs.get(write.dialog_id)
                if old is None:
                    state.dialogs[write.dialog_id] = (*write.row, None)
                elif write.dialog_id in state.deleted_dialogs:
                    pass  # мягко стёртый диалог запись не воскрешает
                else:
                    new = write.row
                    state.dialogs[write.dialog_id] = (
                        old[0], old[1], old[2],
                        new[3], new[4], new[5], new[6], new[7],
                        old[8],  # memory_mode неизменяем после создания
                        max(old[9], new[9]),  # crisis_seen только растёт
                        old[10],  # memory_extracted_at писатель диалогов не трогает
                    )
                for message in write.messages:
                    state.messages[(message[1], message[0])] = message
                state.usage.extend(write.usage)
                for dialog_id, client_id, message_id in write.client_ids:
                    state.client_ids.setdefault((dialog_id, client_id), message_id)
                if write.pref is not None and write.pref[0] not in state.deleted_prefs:
                    state.prefs[write.pref[0]] = write.pref[1]

    def checkpoint(self) -> None:
        return None

    def erase_user(self, user_id: str) -> None:
        with self._lock:
            state = self._state()
            state.deleted_dialogs |= {dialog_id for dialog_id, row in state.dialogs.items() if row[1] == user_id}
            if user_id in state.prefs:
                state.deleted_prefs.add(user_id)
            state.memory_settings.pop(user_id, None)
            state.settings.pop(user_id, None)
            state.memory_deletions.setdefault(user_id, "erased")

    def mark_memory_deleted(self, user_id: str) -> None:
        with self._lock:
            self._state().memory_deletions.setdefault(user_id, "forgotten")

    def clear_memory_deleted(self, user_id: str) -> None:
        with self._lock:
            self._state().memory_deletions.pop(user_id, None)

    def is_memory_deleted(self, user_id: str) -> bool:
        with self._lock:
            return user_id in self._state().memory_deletions

    def get_memory_settings(self, user_id: str) -> tuple[bool, str | None, str | None] | None:
        with self._lock:
            return self._state().memory_settings.get(user_id)

    def put_memory_settings(
        self, user_id: str, enabled: bool, consent_version: str | None, consent_at: str | None, updated_at: str
    ) -> None:
        with self._lock:
            self._state().memory_settings[user_id] = (enabled, consent_version, consent_at)

    def delete_dialog(self, user_id: str, dialog_id: str, forget_derived: bool) -> None:
        with self._lock:
            state = self._state()
            row = state.dialogs.get(dialog_id)
            if row is not None and row[1] == user_id:
                state.deleted_dialogs.add(dialog_id)
