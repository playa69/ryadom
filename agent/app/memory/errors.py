"""Ошибки памяти агента (коды каталога agent-api, раздел 10). REST — `app/api/memory.py`."""


class MemoryServiceError(Exception):
    status = 500
    code = "AGENT_INTERNAL"
    message = "Внутренняя ошибка памяти"
    reason: str | None = None


class MemoryUnavailable(MemoryServiceError):
    status, code, message = 503, "MEMORY_UNAVAILABLE", "Память сейчас недоступна"


class MemoryDisabled(MemoryServiceError):
    status, code, message = 409, "MEMORY_DISABLED", "Память выключена"


class MemoryFull(MemoryServiceError):
    status, code, message = 409, "MEMORY_FULL", "Память заполнена"


class NoteNotFound(MemoryServiceError):
    status, code, message = 404, "NOTE_NOT_FOUND", "Заметка не найдена"


class NoteRejected(MemoryServiceError):
    status, code, message = 422, "NOTE_REJECTED", "Это нельзя запомнить"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class MemoryValidation(MemoryServiceError):
    status, code = 422, "AGENT_VALIDATION"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message
