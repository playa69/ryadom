"""REST-эндпоинты диалогов по контракту app/dev/agent-mock/server.mjs."""

from fastapi import APIRouter, Depends, Query, Response, status

from app.api.deps import AppContext, get_ctx, require_internal_token
from app.schemas.dialogs import (
    DialogDetail,
    DialogListResponse,
    EndDialogRequest,
    EndDialogResponse,
    StartDialogResponse,
)

router = APIRouter(
    prefix="/v1/users",
    tags=["dialogs"],
    dependencies=[Depends(require_internal_token)],
)


def _dialog_not_found() -> Response:
    """404 в формате node-мока: чужой и несуществующий диалог неразличимы."""
    return Response(
        content='{"error": "dialog_not_found"}',
        status_code=status.HTTP_404_NOT_FOUND,
        media_type="application/json",
    )


@router.post("/{user_id}/dialogs", response_model=StartDialogResponse)
async def start_dialog(
    user_id: str,
    ctx: AppContext = Depends(get_ctx),
) -> StartDialogResponse:
    """Начинает диалог или возвращает открытый (идемпотентно)."""
    result = await ctx.store.start_dialog(user_id)
    return StartDialogResponse(
        dialog_id=result.dialog_id,
        resumed=result.resumed,
        greeting=result.greeting,
        since_last_dialog_hours=result.since_last_dialog_hours,
    )


@router.get("/{user_id}/dialogs", response_model=DialogListResponse)
async def list_dialogs(
    user_id: str,
    limit: int = Query(default=20, ge=1, le=50),
    before: str | None = Query(default=None),
    ctx: AppContext = Depends(get_ctx),
) -> DialogListResponse:
    """Возвращает страницу журнала диалогов от новых к старым."""
    items, next_cursor = await ctx.store.list_dialogs(user_id, limit, before)
    return DialogListResponse(items=items, next=next_cursor)


@router.get("/{user_id}/dialogs/{dialog_id}", response_model=DialogDetail)
async def get_dialog(
    user_id: str,
    dialog_id: str,
    ctx: AppContext = Depends(get_ctx),
) -> DialogDetail | Response:
    """Возвращает диалог с сообщениями; 404, если диалог не принадлежит пользователю."""
    try:
        dialog = await ctx.store.get_dialog(user_id, dialog_id)
    except ValueError:
        dialog = None
    if dialog is None:
        return _dialog_not_found()
    return DialogDetail(**dialog)


@router.post("/{user_id}/dialogs/{dialog_id}/end", response_model=EndDialogResponse)
async def end_dialog(
    user_id: str,
    dialog_id: str,
    body: EndDialogRequest | None = None,
    ctx: AppContext = Depends(get_ctx),
) -> EndDialogResponse | Response:
    """Завершает диалог и возвращает сводку; 404 для чужого или несуществующего."""
    try:
        result = await ctx.store.end_dialog(
            user_id,
            dialog_id,
            body.takeaway if body else None,
            body.tension_after if body else None,
        )
    except ValueError:
        result = None
    if result is None:
        return _dialog_not_found()
    return EndDialogResponse(summary=result["summary"])


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def erase_user(
    user_id: str,
    ctx: AppContext = Depends(get_ctx),
) -> Response:
    """Стирает все данные пользователя: диалоги, сообщения, сводки, память."""
    await ctx.store.erase_user(user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
