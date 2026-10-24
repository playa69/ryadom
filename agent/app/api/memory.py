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
from app.memory.service import MemoryServiceError

logger = logging.getLogger("agent.memory")

router = APIRouter(prefix="/v1/users/{user_id}/memory", dependencies=[Depends(require_token)])


def _user(user_id: str) -> str:
    canonical = canonical_user_id(user_id)
    if canonical is None:
        raise validation_error("userId должен быть UUID")
    return canonical


def get_memory_service(request: Request) -> MemoryBackend:
    """Бэкенд памяти приложения: SQLite-сервис или Cognee — по `MEMORY_BACKEND`."""
    service: MemoryBackend | None = getattr(request.app.state, "memory", None)
    if service is None:
        raise AgentError(503, "MEMORY_UNAVAILABLE", "Память сейчас недоступна")
    return service


Memory = Annotated[MemoryBackend, Depends(get_memory_service)]


def _error(error: MemoryServiceError) -> AgentError:
    details = {"reason": error.reason} if error.reason else None
    return AgentError(error.status, error.code, error.message, details)


class SettingsBody(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    enabled: bool
    consent_version: str | None = Field(default=None, alias="consentVersion", max_length=32)


class FactBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: str = Field(max_length=20)
    text: str | None = Field(default=None, max_length=1000)
    slots: dict[str, Any] | None = None


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
        return await memory.update_settings(user, body.enabled, body.consent_version)
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
