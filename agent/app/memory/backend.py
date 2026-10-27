"""Контракт бэкенда памяти агента. Единственная реализация — Cognee (`cognee_backend.py`).

`app.state.memory` и `DialogStore.memory` имеют этот тип. Часть `MemoryLink` (сводка, загрузка, конец диалога,
стирание) вызывает хранилище диалогов, остальное — REST памяти (`app/api/memory.py`) и `/health/ready` (`status`).
Коды ошибок — `app/memory/errors.py`.
"""

from typing import Any, Protocol

from app.services.dialog_store import Dialog, MemoryLink


class MemoryBackend(MemoryLink, Protocol):
    """Память людей: `MemoryLink` хранилища диалогов плюс REST-операции и готовность."""

    def status(self) -> str:
        """Для /health/ready: on | unavailable."""
        ...

    @property
    def available(self) -> bool:
        """Функция работает: бэкенд настроен и готов."""
        ...

    async def drain(self) -> None:
        """Дождаться фоновых задач бэкенда (тесты, остановка)."""
        ...

    async def get_memory(self, user_id: str) -> dict[str, Any]:
        """Состояние памяти человека для REST: настройки, факты, сводка."""
        ...

    async def update_settings(
        self,
        user_id: str,
        enabled: bool | None,
        consent_version: str | None,
        sensitive_enabled: bool | None = None,
        chat_search_enabled: bool | None = None,
    ) -> dict[str, Any]:
        """Включить (только с версией согласия) или выключить память человека; переключатели чувствительного и поиска."""
        ...

    async def add_fact(self, user_id: str, category: str, text: Any, slots: Any) -> dict[str, Any]:
        """Факт, который человек написал сам."""
        ...

    async def patch_fact(
        self,
        user_id: str,
        fact_id: str,
        text: Any = None,
        slots: Any = None,
        status: str | None = None,
        confirm: bool = False,
    ) -> dict[str, Any]:
        """Исправить, закрепить, «Запомнить», «Верно»."""
        ...

    async def delete_fact(self, user_id: str, fact_id: str) -> None:
        """«Забыть» факт."""
        ...

    async def forget_all(self, user_id: str, actor: str = "user") -> None:
        """«Забыть всё»."""
        ...

    async def changes(self, user_id: str, dialog_id: str) -> dict[str, Any]:
        """Что разговор добавил в память: карточка «Я запомнил»."""
        ...

    async def export(self, user_id: str) -> dict[str, Any]:
        """Всё о памяти человека для выгрузки."""
        ...
