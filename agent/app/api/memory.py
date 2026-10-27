"""REST памяти агента: что агент помнит о человеке, согласие и выключатель, правка, «забыть», экспорт (спецификация памяти, MEM-10).

Авторизация и канонизация `userId` — как у диалогов; `userId` берётся только из пути (I5). Чтение, экспорт и стирание работают
всегда, даже при выключенной памяти (I1). Тексты ошибок не содержат фактов (I4): причина отказа — только код.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Store, canonical_user_id, require_token
from app.core.errors import AgentError, validation_error
from app.memory.backend import MemoryBackend
from app.memory.errors import MemoryServiceError

router = APIRouter(prefix="/v1/users/{user_id}/memory", dependencies=[Depends(require_token)])


def _user(user_id: str) -> str:
    canonical = canonical_user_id(user_id)
    if canonical is None:
        raise validation_error("userId должен быть UUID")
    return canonical


def get_memory_service(request: Request) -> MemoryBackend:
    """Бэкенд памяти приложения: Cognee (app/memory/cognee_backend.py)."""
    service: MemoryBackend | None = getattr(request.app.state, "memory", None)
    if service is None:
        raise AgentError(503, "MEMORY_UNAVAILABLE", "Память сейчас недоступна")
    return service


Memory = Annotated[MemoryBackend, Depends(get_memory_service)]


def _notes(memory: MemoryBackend) -> Any:
    """Сервис заметок бэкенда памяти (`NotesService`)."""
    return memory.notes  # type: ignore[attr-defined]


def _error(error: MemoryServiceError) -> AgentError:
    details = {"reason": error.reason} if error.reason else None
    return AgentError(error.status, error.code, error.message, details)


class SettingsBody(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    enabled: bool | None = None
    consent_version: str | None = Field(default=None, alias="consentVersion", max_length=32)
    sensitive_enabled: bool | None = Field(default=None, alias="sensitiveEnabled")
    chat_search_enabled: bool | None = Field(default=None, alias="chatSearchEnabled")


class NoteBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, max_length=1000)


@router.get("")
async def get_memory(user_id: str, store: Store, memory: Memory) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)  # даты источников берутся из диалогов человека
    try:
        return await memory.get_memory(user)
    except MemoryServiceError as error:
        raise _error(error) from error


@router.put("/settings")
async def put_settings(user_id: str, body: SettingsBody, store: Store, memory: Memory) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        return await memory.update_settings(
            user, body.enabled, body.consent_version, body.sensitive_enabled, body.chat_search_enabled
        )
    except MemoryServiceError as error:
        raise _error(error) from error


@router.delete("", status_code=204)
async def forget_all(user_id: str, memory: Memory) -> Response:
    # Память остаётся включённой (PROTEUS-242, 0.4): заметки удаляются сразу, датасет Cognee — через очередь memory_outbox.
    try:
        await memory.forget_all(_user(user_id))
    except MemoryServiceError as error:
        raise _error(error) from error
    return Response(status_code=204)


@router.patch("/notes/{note_id}")
async def patch_note(user_id: str, note_id: str, body: NoteBody, store: Store, memory: Memory) -> dict[str, Any]:
    """Правка заметки: те же проверки, что у новой; отказ — `422 NOTE_REJECTED` с кодом правила."""
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        return await _notes(memory).patch(user, note_id, body.text)
    except MemoryServiceError as error:
        raise _error(error) from error


@router.post("/notes/instruction")
async def notes_instruction(user_id: str, body: NoteBody, store: Store, memory: Memory) -> dict[str, Any]:
    """«Скажи, что поправить или убрать»: просьба человека выполняется извлекателем; ответ — что изменено, удалено, добавлено."""
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        outcome = await memory.instruct(user, body.text)  # type: ignore[attr-defined]
    except MemoryServiceError as error:
        raise _error(error) from error
    if outcome.failed:
        raise AgentError(503, "MEMORY_UNAVAILABLE", "Память сейчас недоступна")
    return {
        "changes": {
            "added": outcome.added,
            "updated": outcome.updated,
            "deleted": outcome.deleted,
            "blocked": outcome.blocked,
        }
    }


@router.delete("/notes/{note_id}", status_code=204)
async def delete_note(user_id: str, note_id: str, memory: Memory) -> Response:
    try:
        await _notes(memory).delete(_user(user_id), note_id)
    except MemoryServiceError as error:
        raise _error(error) from error
    return Response(status_code=204)


@router.delete("/notes", status_code=204)
async def delete_all_notes(user_id: str, memory: Memory) -> Response:
    """«Удалить всю память»: заметки и данные в Cognee уходят, настройки и согласие остаются."""
    try:
        await memory.forget_all(_user(user_id))
    except MemoryServiceError as error:
        raise _error(error) from error
    return Response(status_code=204)


@router.get("/notes")
async def list_notes(user_id: str, store: Store, memory: Memory) -> dict[str, Any]:
    """Живые заметки человека, новые сверху."""
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        return {"notes": await _notes(memory).list(user)}
    except MemoryServiceError as error:
        raise _error(error) from error


@router.get("/changes")
async def changes(
    user_id: str, store: Store, memory: Memory, dialog_id: Annotated[str, Query(alias="dialogId", max_length=64)]
) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        return await memory.changes(user, dialog_id)
    except MemoryServiceError as error:
        raise _error(error) from error


@router.get("/export")
async def export(user_id: str, store: Store, memory: Memory) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        return await memory.export(user)
    except MemoryServiceError as error:
        raise _error(error) from error
