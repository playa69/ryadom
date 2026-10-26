"""REST памяти агента: что агент помнит о человеке, согласие и выключатель, правка, «забыть», экспорт (спецификация памяти, MEM-10).

Авторизация и канонизация `userId` — как у диалогов; `userId` берётся только из пути (I5). Чтение, экспорт и стирание работают
всегда, даже при выключенной памяти (I1). Тексты ошибок не содержат фактов (I4): причина отказа — только код.
"""

import logging
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Store, canonical_user_id, require_token
from app.core.errors import AgentError, validation_error
from app.memory.backend import MemoryBackend
from app.memory.errors import MemoryServiceError

logger = logging.getLogger("agent.memory")

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


class FactBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: str = Field(max_length=20)
    text: str | None = Field(default=None, max_length=1000)
    slots: dict[str, Any] | None = None


class NoteBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, max_length=1000)


class PatchBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str | None = Field(default=None, max_length=1000)
    slots: dict[str, Any] | None = None
    status: Literal["active", "pinned"] | None = None
    confirm: bool = False


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


@router.post("/facts", status_code=201)
async def add_fact(user_id: str, body: FactBody, store: Store, memory: Memory) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        return await memory.add_fact(user, body.category, body.text, body.slots)
    except MemoryServiceError as error:
        logger.info("memory fact rejected code=%s reason=%s", error.code, error.reason)
        raise _error(error) from error


@router.patch("/facts/{fact_id}")
async def patch_fact(user_id: str, fact_id: str, body: PatchBody, store: Store, memory: Memory) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        return await memory.patch_fact(user, fact_id, body.text, body.slots, body.status, body.confirm)
    except MemoryServiceError as error:
        raise _error(error) from error


@router.delete("/facts/{fact_id}", status_code=204)
async def delete_fact(user_id: str, fact_id: str, memory: Memory) -> Response:
    try:
        await memory.delete_fact(_user(user_id), fact_id)
    except MemoryServiceError as error:
        raise _error(error) from error
    return Response(status_code=204)


@router.delete("", status_code=204)
async def forget_all(user_id: str, memory: Memory) -> Response:
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
async def list_notes(
    user_id: str,
    store: Store,
    memory: Memory,
    since: Annotated[str | None, Query(max_length=40)] = None,
    kinds: Annotated[str | None, Query(max_length=200)] = None,
) -> dict[str, Any]:
    """Заметки за период (для «Событий недели» дневника): `since` — ISO-время, `kinds` — виды через запятую."""
    user = _user(user_id)
    await store.ensure_user(user)
    wanted = tuple(item for item in (kinds or "").split(",") if item) or None
    try:
        return {"notes": await _notes(memory).list(user, since, wanted)}
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
