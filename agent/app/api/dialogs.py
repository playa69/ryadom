"""REST диалогов: начать, журнал, история, завершить, стереть пользователя (specs/agent-api)."""

import logging
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Store, canonical_user_id, require_token
from app.core.errors import AgentError, dialog_not_found, validation_error
from app.services.dialog_store import InvalidCursor

logger = logging.getLogger("agent.dialogs")

router = APIRouter(prefix="/v1/users/{user_id}", dependencies=[Depends(require_token)])


def _user(user_id: str) -> str:
    canonical = canonical_user_id(user_id)
    if canonical is None:
        raise validation_error("userId должен быть UUID")
    return canonical


class EndBody(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    takeaway: str | None = Field(default=None, max_length=1000)
    tension_after: int | None = Field(default=None, ge=1, le=10, alias="tensionAfter")


class StartBody(BaseModel):
    """Тело `POST …/dialogs` необязательно. `voice` — голос озвучки по роду; без него берётся прошлый выбор человека.

    `new: true` — начать новый разговор, а не вернуться в открытый: открытый диалог с сообщениями завершается (в журнале он остаётся
    завершённым), ответ с `resumed: false`. Без `new` старт идемпотентен и ничего не меняет: у человека не больше одного открытого
    диалога, повтор возвращает его с `resumed: true`; клиент по `messageCount` решает, спросить ли «продолжить или завершить».
    """

    model_config = ConfigDict(extra="ignore")

    voice: Literal["male", "female"] | None = None
    new: bool = False
    # `off` — разговор «Без памяти»: без сводки и извлечения, текст удаляется через 24 часа (спецификация памяти, MEM-9).
    # Только для нового диалога: возвращённый открытый остаётся со своей памятью.
    memory: Literal["on", "off"] = "on"


@router.post("/dialogs")
async def start_dialog(user_id: str, store: Store, body: StartBody | None = None) -> dict[str, Any]:
    start = body or StartBody()
    user = _user(user_id)
    await store.ensure_user(user)
    dialog, resumed, hours = store.start(user, start.voice, start.new, start.memory)
    logger.info(
        "dialog started dialog=%s resumed=%s new=%s voice=%s memory=%s",
        dialog.id,
        resumed,
        start.new,
        dialog.voice,
        dialog.memory_mode,
    )
    return {
        "dialogId": dialog.id,
        "resumed": resumed,
        "greeting": dialog.greeting,
        "sinceLastDialogHours": hours,
        "voice": dialog.voice,
        "messageCount": len(dialog.messages),
        "lastActivityAt": dialog.last_activity_at,
        "memoryMode": dialog.memory_mode,
        "memoryEnabled": store.memory_enabled(user),
    }


@router.get("/dialogs")
async def list_dialogs(
    user_id: str,
    store: Store,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    before: str | None = None,
) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        items, next_cursor = store.list(user, limit, before)
    except InvalidCursor as error:
        raise validation_error("before принимает только значение из прошлого next") from error
    return {"items": [d.to_item() for d in items], "next": next_cursor}


@router.get("/dialogs/{dialog_id}")
async def get_dialog(user_id: str, dialog_id: str, store: Store) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    dialog = store.get(user, dialog_id)
    if dialog is None:
        raise dialog_not_found()
    return {**dialog.to_item(), "messages": [m.to_json() for m in dialog.messages]}


@router.post("/dialogs/{dialog_id}/end")
async def end_dialog(user_id: str, dialog_id: str, store: Store, body: EndBody | None = None) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    dialog = store.get(user, dialog_id)
    if dialog is None:
        raise dialog_not_found()
    body = body or EndBody()
    return {"summary": store.end(dialog, body.takeaway, body.tension_after)}


@router.delete("", status_code=204)
async def erase_user(user_id: str, store: Store) -> Response:
    try:
        await store.erase_user_durable(_user(user_id))
    except Exception as error:
        # 204 означает «стёрто». Диск недоступен или сбойнул: приложение не должно удалять аккаунт, оно повторит позже.
        logger.error("erase user failed: %s", type(error).__name__)
        raise AgentError(503, "AGENT_INTERNAL", "Не удалось стереть данные, повторите позже") from error
    return Response(status_code=204)
