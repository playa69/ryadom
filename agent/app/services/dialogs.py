"""Персистентность журнала диалогов (PostgreSQL, SQLAlchemy 2.0 async).

Свои таблицы `dialogs`/`messages` в той же БД, где LangGraph держит
checkpointer. Контракт методов и формат JSON — как у node-мока
`app/dev/agent-mock/server.mjs` (camelCase, ISO-даты с «Z»).
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from loguru import logger
from sqlalchemy import DateTime, ForeignKey, String, Text, Uuid, delete, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, selectinload

GREETING_NEW = "Я рядом. С чего начнём?"
GREETING_RESUMED = "Продолжим, где остановились."


class Base(DeclarativeBase):
    """Базовый класс ORM-моделей журнала."""


class Dialog(Base):
    """Диалог пользователя с агентом."""

    __tablename__ = "dialogs"

    dialog_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(255), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="dialog",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
        lazy="selectin",
    )


class Message(Base):
    """Сообщение внутри диалога (реплика пользователя или ассистента)."""

    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    dialog_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("dialogs.dialog_id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC))

    dialog: Mapped[Dialog] = relationship(back_populates="messages")


@dataclass
class StartDialogResult:
    """Результат открытия диалога (ответ POST /v1/users/{userId}/dialogs)."""

    dialog_id: str
    resumed: bool
    greeting: str
    since_last_dialog_hours: int | None


def _iso(value: datetime) -> str:
    """Сериализует datetime в ISO 8601 с суффиксом «Z», как node-мок.

    Args:
        value: Момент времени (ожидается tz-aware из timestamptz).

    Returns:
        Строка вида ``2026-10-08T12:34:56.789012Z``.
    """
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime:
    """Парсит ISO-дату курсора (допускает «Z» и числовое смещение).

    Args:
        value: Строка даты из query-параметра ``before``.

    Returns:
        Tz-aware datetime для сравнения с ``started_at``.
    """
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _message_dict(message: Message) -> dict[str, Any]:
    """Приводит ORM-сообщение к JSON-формату node-мока.

    Args:
        message: ORM-модель сообщения.

    Returns:
        Словарь ``{id, role, text, createdAt}``.
    """
    return {
        "id": str(message.id),
        "role": message.role,
        "text": message.text,
        "createdAt": _iso(message.created_at),
    }


def _dialog_item(dialog: Dialog) -> dict[str, Any]:
    """Элемент журнала без сообщений (GET /dialogs).

    Args:
        dialog: ORM-модель диалога.

    Returns:
        Словарь ``{dialogId, startedAt, endedAt, summary}``.
    """
    return {
        "dialogId": str(dialog.dialog_id),
        "startedAt": _iso(dialog.started_at),
        "endedAt": _iso(dialog.ended_at) if dialog.ended_at else None,
        "summary": dialog.summary,
    }


def _build_summary(dialog: Dialog, takeaway: str | None, tension_after: int | None) -> dict[str, Any]:
    """Собирает summary завершённого диалога по правилам node-мока.

    Args:
        dialog: ORM-модель диалога с загруженными сообщениями.
        takeaway: Главный вывод диалога, если клиент его передал.
        tension_after: Уровень напряжения после диалога (0-10), если передан.

    Returns:
        Словарь ``{title, themes, tensionBefore, tensionAfter}``.
    """
    first_user_message = next((message for message in dialog.messages if message.role == "user"), None)
    return {
        "title": takeaway[:80] if takeaway else (first_user_message.text[:80] if first_user_message else "Разговор"),
        "themes": ["выговориться"],
        "tensionBefore": None,
        "tensionAfter": tension_after,
    }


class DialogStore:
    """Хранилище журнала диалогов поверх async SQLAlchemy."""

    def __init__(self, engine: AsyncEngine) -> None:
        """Инициализирует хранилище готовым движком.

        Args:
            engine: Async SQLAlchemy engine (обычно asyncpg).
        """
        self._engine = engine
        self._session_factory = async_sessionmaker(engine, expire_on_commit=False)

    @classmethod
    async def create(cls, database_url: str) -> "DialogStore":
        """Создаёт хранилище и гарантирует наличие таблиц журнала.

        Args:
            database_url: DSN вида ``postgresql://user:pass@host:port/db``
                или сразу ``postgresql+asyncpg://...``.

        Returns:
            Готовый к работе экземпляр DialogStore.
        """
        if database_url.startswith("postgresql://"):
            database_url = f"postgresql+asyncpg://{database_url.removeprefix('postgresql://')}"
        engine = create_async_engine(database_url, pool_pre_ping=True)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        return cls(engine)

    async def start_dialog(self, user_id: str) -> StartDialogResult:
        """Открывает новый диалог или возвращает текущий открытый.

        Args:
            user_id: Идентификатор пользователя.

        Returns:
            StartDialogResult с приветствием и числом часов с последнего
            завершённого диалога (None, если завершённых не было).
        """
        async with self._session_factory() as session:
            existing = await session.scalar(
                select(Dialog)
                .where(Dialog.user_id == user_id, Dialog.ended_at.is_(None))
                .order_by(Dialog.started_at.desc())
                .limit(1)
            )
            resumed = existing is not None
            dialog = existing if resumed else Dialog(user_id=user_id)
            if not resumed:
                session.add(dialog)
                await session.flush()
            since = await self._hours_since_last_dialog(session, user_id)
            await session.commit()
        logger.info(
            "Диалог {}: {}",
            "возобновлён" if resumed else "создан",
            dialog.dialog_id,
        )
        return StartDialogResult(
            dialog_id=str(dialog.dialog_id),
            resumed=resumed,
            greeting=GREETING_RESUMED if resumed else GREETING_NEW,
            since_last_dialog_hours=since,
        )

    async def list_dialogs(
        self, user_id: str, limit: int, before: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        """Возвращает журнал пользователя с курсорной пагинацией.

        Args:
            user_id: Идентификатор пользователя.
            limit: Максимум элементов на страницу.
            before: Курсор — ISO-дата ``startedAt``; берутся диалоги строго старше.

        Returns:
            Кортеж (items, next), где next — курсор следующей страницы
            либо None, если страница последняя.
        """
        async with self._session_factory() as session:
            stmt = select(Dialog).where(Dialog.user_id == user_id)
            if before:
                stmt = stmt.where(Dialog.started_at < _parse_iso(before))
            stmt = stmt.order_by(Dialog.started_at.desc()).limit(limit + 1)
            rows = list((await session.scalars(stmt)).all())
        next_cursor = None
        if len(rows) > limit:
            rows = rows[:limit]
            next_cursor = _iso(rows[-1].started_at)
        return [_dialog_item(row) for row in rows], next_cursor

    async def get_dialog(self, user_id: str, dialog_id: str) -> dict[str, Any] | None:
        """Возвращает диалог с сообщениями либо None, если он не найден.

        Args:
            user_id: Идентификатор пользователя (владельца диалога).
            dialog_id: Идентификатор диалога.

        Returns:
            Словарь ``{dialogId, startedAt, endedAt, summary, messages}``.
        """
        async with self._session_factory() as session:
            dialog = await session.scalar(
                select(Dialog)
                .options(selectinload(Dialog.messages))
                .where(Dialog.dialog_id == uuid.UUID(dialog_id), Dialog.user_id == user_id)
            )
        if dialog is None:
            return None
        return {
            **_dialog_item(dialog),
            "messages": [_message_dict(message) for message in dialog.messages],
        }

    async def append_message(self, dialog_id: str, role: str, text: str) -> dict[str, Any]:
        """Добавляет сообщение в диалог.

        Args:
            dialog_id: Идентификатор диалога.
            role: Роль автора (``user``/``assistant``).
            text: Текст реплики.

        Returns:
            Словарь ``{id, role, text, createdAt}``.
        """
        async with self._session_factory() as session:
            message = Message(dialog_id=uuid.UUID(dialog_id), role=role, text=text)
            session.add(message)
            await session.commit()
            await session.refresh(message)
        return _message_dict(message)

    async def end_dialog(
        self,
        user_id: str,
        dialog_id: str,
        takeaway: str | None,
        tension_after: int | None,
    ) -> dict[str, Any] | None:
        """Завершает диалог и фиксирует summary.

        Args:
            user_id: Идентификатор пользователя (владельца диалога).
            dialog_id: Идентификатор диалога.
            takeaway: Главный вывод диалога, если передан.
            tension_after: Уровень напряжения после диалога, если передан.

        Returns:
            Словарь ``{summary}`` либо None, если диалог не найден.
        """
        async with self._session_factory() as session:
            dialog = await session.scalar(
                select(Dialog)
                .options(selectinload(Dialog.messages))
                .where(Dialog.dialog_id == uuid.UUID(dialog_id), Dialog.user_id == user_id)
            )
            if dialog is None:
                return None
            dialog.ended_at = datetime.now(UTC)
            dialog.summary = _build_summary(dialog, takeaway, tension_after)
            summary = dialog.summary
            await session.commit()
        logger.info("Диалог завершён: {}", dialog_id)
        return {"summary": summary}

    async def erase_user(self, user_id: str) -> None:
        """Каскадно удаляет все диалоги и сообщения пользователя.

        Вместе с журналом стираются и LLM-чекпоинты истории этих диалогов
        (таблицы LangGraph), если чекпоинтер инициализирован в той же БД.

        Args:
            user_id: Идентификатор пользователя.
        """
        async with self._session_factory() as session:
            thread_ids = [
                str(dialog_id)
                for dialog_id in await session.scalars(
                    select(Dialog.dialog_id).where(Dialog.user_id == user_id)
                )
            ]
            await session.execute(delete(Dialog).where(Dialog.user_id == user_id))
            has_checkpoints = await session.scalar(text("SELECT to_regclass('checkpoints')"))
            if thread_ids and has_checkpoints is not None:
                for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
                    await session.execute(
                        text(f"DELETE FROM {table} WHERE thread_id = ANY(:thread_ids)"),
                        {"thread_ids": thread_ids},
                    )
            await session.commit()
        logger.info("Стёрты все данные пользователя {}", user_id)

    async def close(self) -> None:
        """Освобождает пул соединений."""
        await self._engine.dispose()

    async def _hours_since_last_dialog(self, session: Any, user_id: str) -> int | None:
        """Считает часы с момента завершения последнего диалога.

        Args:
            session: Активная async-сессия.
            user_id: Идентификатор пользователя.

        Returns:
            Округлённое число часов либо None, если завершённых диалогов нет.
        """
        ended_at = await session.scalar(
            select(Dialog.ended_at)
            .where(Dialog.user_id == user_id, Dialog.ended_at.isnot(None))
            .order_by(Dialog.ended_at.desc())
            .limit(1)
        )
        if ended_at is None:
            return None
        return round((datetime.now(UTC) - ended_at).total_seconds() / 3600)
