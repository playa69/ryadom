"""Служебные эндпоинты: без токена и без access-лога (specs/agent-api «Служебные эндпоинты»)."""

from fastapi import APIRouter, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from app.api.deps import active_tts
from app.core.config import APP_CONFIG

router = APIRouter()


@router.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready", include_in_schema=False)
async def ready(request: Request) -> dict[str, str]:
    # Модели и озвучка не обязательны для готовности: при их отказе агент отвечает шаблоном и текстом.
    tts = active_tts(request.app)
    chat, recognizer = request.app.state.chat, request.app.state.recognizer
    return {
        "status": "ok",
        "tts": tts.name if tts else "none",
        "llm": chat.name if chat else "none",
        "stt": recognizer.name if recognizer else "none",
    }


@router.get("/version", include_in_schema=False)
async def version() -> dict[str, str]:
    return {"version": APP_CONFIG.app.version}


@router.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    """Prometheus: счётчики голосового диалога (app.core.metrics). Внутри кластера, как и /health."""
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
