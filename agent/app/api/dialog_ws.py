"""WebSocket диалога (specs/agent-api «Разговор по WebSocket»): рукопожатие и выдача сокета сессии.

Один сокет на диалог. Всё, что происходит внутри сокета, делает `DialogSession` (app/api/dialog_live.py).
"""

import json
import logging

from fastapi import APIRouter, WebSocket
from fastapi.responses import JSONResponse

from app.api.deps import canonical_user_id, token_ok
from app.api.dialog_live import DialogSession
from app.core.errors import error_body
from app.services.dialog_store import DialogStore

logger = logging.getLogger("agent.ws")

router = APIRouter()


async def _deny(websocket: WebSocket, status: int, code: str, message: str) -> None:
    """Отклонить рукопожатие HTTP-статусом (401/404/409), как требует контракт."""
    try:
        await websocket.send_denial_response(JSONResponse(error_body(code, message), status_code=status))
    except RuntimeError:
        # Сервер не умеет HTTP-ответ на рукопожатие: закрываем сокет, статус достанется библиотеке.
        await websocket.close(code=1008)


@router.websocket("/v1/users/{user_id}/dialogs/{dialog_id}/ws")
async def dialog_ws(websocket: WebSocket, user_id: str, dialog_id: str) -> None:
    if not token_ok(websocket.headers.get("authorization")):
        return await _deny(websocket, 401, "AGENT_UNAUTHORIZED", "Нужен внутренний токен")

    app = websocket.app
    store: DialogStore = app.state.store
    canonical = canonical_user_id(user_id)
    if canonical:
        await store.ensure_user(canonical)  # после перезапуска диалоги человека поднимаются с диска
    dialog = store.get(canonical, dialog_id) if canonical else None
    # Чужой и несуществующий диалог неразличимы.
    if dialog is None:
        return await _deny(websocket, 404, "AGENT_DIALOG_NOT_FOUND", "Диалог не найден")
    # Один живой сокет на диалог: второе соединение отклоняем, первое не трогаем.
    if dialog.has_live_socket:
        return await _deny(websocket, 409, "AGENT_VALIDATION", "У диалога уже есть живое соединение")

    store.socket_opened(dialog)
    try:
        await websocket.accept()
        logger.info("socket opened dialog=%s", dialog.id)
        if dialog.ended_at is not None:
            # Диалог завершён (человек начал новый разговор с другого экрана, а этот был без связи): в него больше ничего не пишем.
            await websocket.send_text(json.dumps({"v": 1, "type": "ready"}))
            await websocket.send_text(json.dumps({"v": 1, "type": "ended", "summary": dialog.summary}, ensure_ascii=False))
            await websocket.close(code=1000)
            return
        session = DialogSession(
            websocket, store, dialog, lambda: app.state.tts, app.state.live, budget=app.state.budget, tracer=app.state.tracer
        )
        session.bind_component_calls()
        await session.run()
    finally:
        store.socket_closed(dialog)
        logger.info("socket closed dialog=%s", dialog.id)
