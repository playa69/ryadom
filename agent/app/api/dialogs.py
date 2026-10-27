"""REST диалогов: начать, журнал, история, завершить, стереть пользователя (specs/agent-api)."""

import logging
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import Store, canonical_user_id, require_token
from app.core.voices import GEMINI_VOICE_NAMES
from app.core.errors import AgentError, dialog_not_found, validation_error
from app.services import recaps
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
    # `takeaway` и есть итог; `draft` — поле предзаполнил черновик «Предзаполнить» (и, возможно, поправил человек).
    recap_source: Literal["manual", "draft"] = Field(default="manual", alias="recapSource")


class RecapPutBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    recap: str = Field(max_length=recaps.RECAP_MAX)
    source: Literal["manual", "draft"] = "manual"


class DialogSettingsBody(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    recap_enabled: bool = Field(alias="recapEnabled")


class StartBody(BaseModel):
    """Тело `POST …/dialogs` необязательно. `voice` — голос озвучки по роду; без него берётся прошлый выбор человека.

    `new: true` — начать новый разговор, а не вернуться в открытый: открытый диалог с сообщениями завершается (в журнале он остаётся
    завершённым), ответ с `resumed: false`. Без `new` старт идемпотентен и ничего не меняет: у человека не больше одного открытого
    диалога, повтор возвращает его с `resumed: true`; клиент по `messageCount` решает, спросить ли «продолжить или завершить».
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    voice: Literal["male", "female"] | None = None
    # Конкретный голос Gemini (профиль): действует только вместе с `voice` (его родом).
    voice_name: str | None = Field(default=None, alias="voiceName", max_length=32)
    new: bool = False
    # `off` — разговор «Без памяти»: без заметок и индекса (срок хранения и пометка в журнале — `add-unsaved-dialog`).
    # Только для нового диалога: возвращённый открытый остаётся со своей памятью.
    memory: Literal["on", "off"] = "on"


@router.post("/dialogs")
async def start_dialog(user_id: str, store: Store, body: StartBody | None = None) -> dict[str, Any]:
    start = body or StartBody()
    if start.voice_name is not None and start.voice_name not in GEMINI_VOICE_NAMES:
        raise validation_error("voiceName: неизвестный голос")
    user = _user(user_id)
    await store.ensure_user(user)
    dialog, resumed, hours = store.start(user, start.voice, start.new, start.memory, start.voice_name)
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
        "voiceName": dialog.voice_name,
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
    return {"summary": store.end(dialog, body.takeaway, body.tension_after, body.recap_source)}


def _recap_unavailable() -> AgentError:
    return AgentError(409, "RECAP_NOT_AVAILABLE", "Для этого разговора итога нет")


def _ended_dialog(store: Store, user_id: str, dialog_id: str):  # type: ignore[no-untyped-def]
    dialog = store.get(user_id, dialog_id)
    if dialog is None:
        raise dialog_not_found()
    return dialog


@router.post("/dialogs/{dialog_id}/recap/draft")
async def draft_recap(user_id: str, dialog_id: str, store: Store) -> dict[str, Any]:
    """Черновик итога для «Предзаполнить»: ничего не сохраняется, итог разговора и его статус не меняются."""
    user = _user(user_id)
    await store.ensure_user(user)
    dialog = _ended_dialog(store, user, dialog_id)
    if not store.can_recap(dialog):
        raise _recap_unavailable()
    draft = await store.draft_recap(dialog)
    if draft is None:
        raise AgentError(502, "RECAP_UNAVAILABLE", "Модель не составила черновик")
    return {"recap": draft}


@router.put("/dialogs/{dialog_id}/recap")
async def put_recap(user_id: str, dialog_id: str, body: RecapPutBody, store: Store) -> dict[str, Any]:
    """Итог завершённого разговора, написанный человеком в журнале («Написать итог», «Предзаполнить» → «Сохранить»)."""
    user = _user(user_id)
    await store.ensure_user(user)
    dialog = _ended_dialog(store, user, dialog_id)
    if dialog.summary is None:
        raise AgentError(409, "DIALOG_NOT_ENDED", "Разговор ещё не завершён")
    summary = store.set_recap(dialog, body.recap, body.source)
    if summary is None:
        raise _recap_unavailable()
    return {"summary": summary}


@router.delete("/dialogs/{dialog_id}", status_code=204)
async def delete_dialog(user_id: str, dialog_id: str, store: Store) -> Response:
    """«Удалить разговор» в журнале: разговор с итогом удаляется мягко (`deleted_at`), его документ в индексе прошлых разговоров
    уходит в очередь на жёсткое удаление (`memory.dialog_deleting`). Открытый разговор сначала завершается (сокет получает
    `ended`), автоитог и извлечение памяти для него не запускаются. Заметки памяти и итоги недели агент не трогает.
    Чужой и несуществующий — `404`."""
    user = _user(user_id)
    await store.ensure_user(user)
    dialog = _ended_dialog(store, user, dialog_id)
    try:
        await store.delete_by_person(dialog)
    except Exception as error:
        logger.error("delete dialog failed: %s", type(error).__name__)
        raise AgentError(503, "AGENT_INTERNAL", "Не удалось удалить разговор, повторите позже") from error
    logger.info("dialog deleted by the person dialog=%s", dialog_id)
    return Response(status_code=204)


@router.get("/recaps")
async def list_recaps(
    user_id: str,
    store: Store,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    before: str | None = None,
) -> dict[str, Any]:
    """Разговоры с готовым итогом, новые сверху (записи журнала и вход итогов недели)."""
    user = _user(user_id)
    await store.ensure_user(user)
    try:
        items, next_cursor = store.list_recaps(user, limit, before)
    except InvalidCursor as error:
        raise validation_error("before принимает только значение из прошлого next") from error
    return {
        "items": [
            {
                "dialogId": d.id,
                "startedAt": d.started_at,
                "endedAt": d.ended_at,
                "title": (d.summary or {}).get("title"),
                "recap": (d.summary or {}).get("recap"),
                "recapSource": (d.summary or {}).get("recapSource"),
                "recapAt": (d.summary or {}).get("recapAt"),
            }
            for d in items
        ],
        "next": next_cursor,
    }


@router.get("/dialog-settings")
async def get_dialog_settings(user_id: str, store: Store) -> dict[str, Any]:
    user = _user(user_id)
    await store.ensure_user(user)
    return {"recapEnabled": store.recap_enabled(user)}


@router.put("/dialog-settings")
async def put_dialog_settings(user_id: str, body: DialogSettingsBody, store: Store) -> dict[str, Any]:
    """«Подводить итог автоматически»: отдельно от настроек памяти, согласия на память не требует."""
    user = _user(user_id)
    await store.ensure_user(user)
    store.set_recap_enabled(user, body.recap_enabled)
    return {"recapEnabled": store.recap_enabled(user)}


@router.delete("", status_code=204)
async def erase_user(user_id: str, store: Store) -> Response:
    user = _user(user_id)
    memory = store.memory
    if memory is not None:
        try:
            await memory.erase_user_data(user)  # индекс в Cognee удаляется до 204; недоступен — 503, аккаунт не трогается
        except Exception as error:
            logger.error("erase user memory failed: %s", type(error).__name__)
            raise AgentError(503, "AGENT_INTERNAL", "Не удалось стереть данные, повторите позже") from error
    try:
        await store.erase_user_durable(user)
    except Exception as error:
        # 204 означает «стёрто». Диск недоступен или сбойнул: приложение не должно удалять аккаунт, оно повторит позже.
        logger.error("erase user failed: %s", type(error).__name__)
        raise AgentError(503, "AGENT_INTERNAL", "Не удалось стереть данные, повторите позже") from error
    return Response(status_code=204)
