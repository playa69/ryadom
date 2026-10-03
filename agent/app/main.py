"""Точка входа сервиса agent «Слышу Рядом».

Скелет (tasks 1.5): health/version-эндпоинты. Middleware заголовков,
логирование, internal-роутеры и lifespan клиентов добавляются
по openspec/changes/add-agent-service/tasks.md.
"""

from fastapi import FastAPI

from app.core.config import APP_CONFIG


def create_app() -> FastAPI:
    """Собирает FastAPI-приложение agent."""
    app = FastAPI(title="ryadom-agent", version=APP_CONFIG.app.version)

    @app.get("/health", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/version", include_in_schema=False)
    async def version() -> dict[str, str]:
        return {"version": APP_CONFIG.app.version}

    return app


app = create_app()
