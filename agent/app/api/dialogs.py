"""REST диалогов: начать, журнал, история, завершить, стереть пользователя (specs/agent-api)."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Store, canonical_user_id, require_token
from app.core.errors import dialog_not_found, validation_error
from app.services.dialog_store import InvalidCursor

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
    """Тело `POST …/dialogs` необязательно. `voice` — голос озвучки по роду; без него берётся прошлый выбор человека."""

    model_config = ConfigDict(extra="ignore")

    voice: Literal["male", "female"] | None = None


@router.post("/dialogs")
async def start_dialog(user_id: str, store: Store, body: StartBody | None = None) -> dict[str, Any]:
    dialog, resumed, hours = store.start(_user(user_id), (body or StartBody()).voice)
    return {
        "dialogId": dialog.id,
        "resumed": resumed,
        "greeting": dialog.greeting,
        "sinceLastDialogHours": hours,
        "voice": dialog.voice,
    }


@router.get("/dialogs")
async def list_dialogs(
    user_id: str,
    store: Store,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    before: str | None = None,
) -> dict[str, Any]:
    try:
        items, next_cursor = store.list(_user(user_id), limit, before)
    except InvalidCursor as error:
        raise validation_error("before принимает только значение из прошлого next") from error
    return {"items": [d.to_item() for d in items], "next": next_cursor}


@router.get("/dialogs/{dialog_id}")
async def get_dialog(user_id: str, dialog_id: str, store: Store) -> dict[str, Any]:
    dialog = store.get(_user(user_id), dialog_id)
    if dialog is None:
        raise dialog_not_found()
    return {**dialog.to_item(), "messages": [m.to_json() for m in dialog.messages]}


@router.post("/dialogs/{dialog_id}/end")
async def end_dialog(user_id: str, dialog_id: str, store: Store, body: EndBody | None = None) -> dict[str, Any]:
    dialog = store.get(_user(user_id), dialog_id)
    if dialog is None:
        raise dialog_not_found()
    body = body or EndBody()
    return {"summary": store.end(dialog, body.takeaway, body.tension_after)}


@router.delete("", status_code=204)
async def erase_user(user_id: str, store: Store) -> Response:
    store.erase_user(_user(user_id))
    return Response(status_code=204)
