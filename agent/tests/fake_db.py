"""In-memory двойник `DialogDatabase` для тестов: та же семантика без PostgreSQL и без файла.

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
        self.usage: list[tuple] = []


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
                if row[1] != user_id:
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
            return dialogs, state.prefs.get(user_id)

    def apply(self, writes: list[DialogWrite]) -> None:
        with self._lock:
            state = self._state()
            for write in writes:
                old = state.dialogs.get(write.dialog_id)
                if old is None:
                    state.dialogs[write.dialog_id] = (*write.row, None)
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
                if write.pref is not None:
                    state.prefs[write.pref[0]] = write.pref[1]

    def checkpoint(self) -> None:
        return None

    def erase_user(self, user_id: str) -> None:
        with self._lock:
            state = self._state()
            gone = {dialog_id for dialog_id, row in state.dialogs.items() if row[1] == user_id}
            state.dialogs = {k: v for k, v in state.dialogs.items() if k not in gone}
            state.messages = {k: v for k, v in state.messages.items() if k[0] not in gone}
            state.client_ids = {k: v for k, v in state.client_ids.items() if k[0] not in gone}
            state.usage = [row for row in state.usage if row[0] not in gone]
            state.prefs.pop(user_id, None)

    def delete_dialog(self, user_id: str, dialog_id: str, forget_derived: bool) -> None:
        with self._lock:
            state = self._state()
            state.dialogs.pop(dialog_id, None)
            state.messages = {k: v for k, v in state.messages.items() if k[0] != dialog_id}
            state.client_ids = {k: v for k, v in state.client_ids.items() if k[0] != dialog_id}
            state.usage = [row for row in state.usage if row[0] != dialog_id]
