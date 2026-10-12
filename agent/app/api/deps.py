"""Зависимости API: внутренняя авторизация и доступ к состоянию приложения."""

import hmac
import uuid
from typing import Annotated, Any

from fastapi import Depends, Header, Request

from app.clients.speech import TextToSpeech
from app.core.config import APP_CONFIG
from app.core.errors import unauthorized
from app.services.dialog_store import DialogStore


def token_ok(authorization: str | None) -> bool:
    """`Authorization: Bearer <внутренний токен>`; сравнение за постоянное время."""
    if not authorization:
        return False
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value:
        return False
    expected = APP_CONFIG.security.internal_token.get_secret_value()
    return hmac.compare_digest(value.strip().encode(), expected.encode())


async def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    if not token_ok(authorization):
        raise unauthorized()


def get_store(request: Request) -> DialogStore:
    return request.app.state.store


def active_tts(app: Any) -> TextToSpeech | None:
    """Озвучка, которая работает сейчас: настроенный провайдер, если dev-режим не выключил его (`POST /dev/tts`)."""
    return app.state.tts if app.state.tts_mode == "auto" else None


def active_cascade_tts(app: Any) -> TextToSpeech | None:
    """Озвучка каскада в режиме gemini_live: ею говорят ответы, написанные каскадом при откате (голос Qwen, если настроен)."""
    return app.state.cascade_tts if app.state.tts_mode == "auto" else None


def get_tts(request: Request) -> TextToSpeech | None:
    return active_tts(request.app)


def canonical_user_id(user_id: str) -> str | None:
    """userId — UUID (specs/agent-api «Идентификаторы»): приводим к одному виду или отклоняем."""
    try:
        return str(uuid.UUID(user_id))
    except ValueError:
        return None


Store = Annotated[DialogStore, Depends(get_store)]
