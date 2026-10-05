"""Служебные эндпоинты: без токена и без access-лога (specs/agent-api «Служебные эндпоинты»)."""

from fastapi import APIRouter, Request

from app.api.deps import active_tts
from app.core.config import APP_CONFIG

router = APIRouter()


@router.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready", include_in_schema=False)
async def ready(request: Request) -> dict[str, str]:
    # Внешних обязательных зависимостей пока нет: LLM, БД и Redis появятся с настоящим агентом.
    tts = active_tts(request.app)
    return {"status": "ok", "tts": tts.name if tts else "none"}


@router.get("/version", include_in_schema=False)
async def version() -> dict[str, str]:
    return {"version": APP_CONFIG.app.version}
