"""Зависимости FastAPI: контекст приложения и внутренняя авторизация."""

import secrets
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.clients.llm import CloudRuLLMClient
from app.core.config import APP_CONFIG
from app.services.dialogs import DialogStore


@dataclass
class AppContext:
    """Контекст приложения, собранный в lifespan и лежащий в app.state.ctx."""

    llm: CloudRuLLMClient
    store: DialogStore
    checkpointer: Any
    graph: Any = None


_bearer = HTTPBearer(auto_error=False)


def _token_valid(token: str) -> bool:
    """Сравнивает токен с AGENT_INTERNAL_TOKEN в константном времени."""
    expected = APP_CONFIG.security.internal_token.get_secret_value()
    return secrets.compare_digest(token, expected)


async def require_internal_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Проверяет Bearer AGENT_INTERNAL_TOKEN на REST-эндпоинтах, иначе 401."""
    if credentials is None or not _token_valid(credentials.credentials):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="unauthorized",
        )


def is_authorized(authorization: str | None) -> bool:
    """Проверяет заголовок Authorization рукопожатия WebSocket."""
    if not authorization or not authorization.startswith("Bearer "):
        return False
    return _token_valid(authorization.removeprefix("Bearer ").strip())


def get_ctx(request: Request) -> AppContext:
    """Возвращает контекст приложения из app.state.ctx."""
    return request.app.state.ctx
