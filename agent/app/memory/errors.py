"""Ошибки памяти агента (коды каталога agent-api, раздел 10). REST — `app/api/memory.py`."""


class MemoryServiceError(Exception):
    status = 500
    code = "AGENT_INTERNAL"
    message = "Внутренняя ошибка памяти"
    reason: str | None = None


class MemoryUnavailable(MemoryServiceError):
    status, code, message = 503, "MEMORY_UNAVAILABLE", "Память сейчас недоступна"


class MemoryNotAllowed(MemoryServiceError):
    status, code, message = 403, "MEMORY_NOT_ALLOWED", "Память пока доступна не всем"


class MemoryDisabled(MemoryServiceError):
    status, code, message = 409, "MEMORY_DISABLED", "Память выключена"


class MemoryFull(MemoryServiceError):
    status, code, message = 409, "MEMORY_FULL", "Память заполнена"


class FactNotFound(MemoryServiceError):
    status, code, message = 404, "FACT_NOT_FOUND", "Факт не найден"


class FactRejected(MemoryServiceError):
    status, code, message = 422, "FACT_REJECTED", "Это нельзя запомнить"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class NoteNotFound(MemoryServiceError):
    status, code, message = 404, "NOTE_NOT_FOUND", "Заметка не найдена"


class NoteRejected(MemoryServiceError):
    status, code, message = 422, "NOTE_REJECTED", "Это нельзя запомнить"

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class MemoryActionUnsupported(MemoryServiceError):
    status, code, message = 422, "MEMORY_ACTION_UNSUPPORTED", "Это действие с памятью больше не поддерживается"


class MemoryValidation(MemoryServiceError):
    status, code = 422, "AGENT_VALIDATION"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class DialogMissing(MemoryServiceError):
    status, code, message = 404, "AGENT_DIALOG_NOT_FOUND", "Диалог не найден"
