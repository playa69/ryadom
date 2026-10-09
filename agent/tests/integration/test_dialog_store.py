"""Интеграционные тесты DialogStore поверх реального Postgres."""

import uuid
from collections.abc import AsyncIterator

import pytest

from app.services.dialogs import GREETING_NEW, GREETING_RESUMED, DialogStore


@pytest.fixture
async def store(pg_dsn: str) -> AsyncIterator[DialogStore]:
    """Хранилище поверх тестового Postgres; таблицы создаются идемпотентно."""
    instance = await DialogStore.create(pg_dsn)
    yield instance
    await instance.close()


def _user_id() -> str:
    return f"user-{uuid.uuid4()}"


async def test_start_dialog_creates_new(store: DialogStore) -> None:
    """Первый старт: новый диалог, приветствие нового диалога, без since."""
    user = _user_id()
    result = await store.start_dialog(user)
    assert not result.resumed
    assert result.greeting == GREETING_NEW
    assert result.since_last_dialog_hours is None
    uuid.UUID(result.dialog_id)


async def test_start_dialog_is_idempotent(store: DialogStore) -> None:
    """Повторный старт возвращает тот же открытый диалог с resumed=True."""
    user = _user_id()
    first = await store.start_dialog(user)
    second = await store.start_dialog(user)
    assert second.resumed
    assert second.greeting == GREETING_RESUMED
    assert second.dialog_id == first.dialog_id


async def test_append_and_get_dialog(store: DialogStore) -> None:
    """Сообщения сохраняются и читаются в camelCase с ISO-датой на «Z»."""
    user = _user_id()
    dialog_id = (await store.start_dialog(user)).dialog_id
    await store.append_message(dialog_id, "user", "Привет")
    await store.append_message(dialog_id, "assistant", "Я рядом")
    dialog = await store.get_dialog(user, dialog_id)
    assert dialog is not None
    assert dialog["dialogId"] == dialog_id
    assert dialog["endedAt"] is None
    assert dialog["summary"] is None
    assert [m["role"] for m in dialog["messages"]] == ["user", "assistant"]
    assert dialog["messages"][0]["text"] == "Привет"
    assert dialog["messages"][0]["createdAt"].endswith("Z")


async def test_get_dialog_of_other_user_is_none(store: DialogStore) -> None:
    """Чужой диалог неотличим от несуществующего."""
    dialog_id = (await store.start_dialog(_user_id())).dialog_id
    assert await store.get_dialog(_user_id(), dialog_id) is None


async def test_get_dialog_invalid_uuid_raises_value_error(store: DialogStore) -> None:
    """Не-UUID dialog_id пробрасывает ValueError (API-слой переводит в 404)."""
    with pytest.raises(ValueError):
        await store.get_dialog(_user_id(), "not-a-uuid")


async def test_end_dialog_builds_summary(store: DialogStore) -> None:
    """Завершение фиксирует summary с title из takeaway и tensionAfter."""
    user = _user_id()
    dialog_id = (await store.start_dialog(user)).dialog_id
    await store.append_message(dialog_id, "user", "Тяжёлый день")
    result = await store.end_dialog(user, dialog_id, "Выговорился и полегчало", 4)
    assert result is not None
    summary = result["summary"]
    assert summary["title"] == "Выговорился и полегчало"
    assert summary["tensionAfter"] == 4
    assert summary["themes"] == ["выговориться"]

    dialog = await store.get_dialog(user, dialog_id)
    assert dialog is not None
    assert dialog["endedAt"] is not None
    assert dialog["summary"] == summary

    restarted = await store.start_dialog(user)
    assert not restarted.resumed
    assert restarted.dialog_id != dialog_id
    assert restarted.since_last_dialog_hours == 0


async def test_end_dialog_title_from_first_message(store: DialogStore) -> None:
    """Без takeaway title берётся из первой реплики пользователя."""
    user = _user_id()
    dialog_id = (await store.start_dialog(user)).dialog_id
    await store.append_message(dialog_id, "user", "Первая реплика")
    result = await store.end_dialog(user, dialog_id, None, None)
    assert result is not None
    assert result["summary"]["title"] == "Первая реплика"


async def test_end_dialog_unknown_returns_none(store: DialogStore) -> None:
    """Завершение несуществующего диалога — None; битый uuid — ValueError."""
    user = _user_id()
    assert await store.end_dialog(user, str(uuid.uuid4()), None, None) is None
    with pytest.raises(ValueError):
        await store.end_dialog(user, "broken", None, None)


async def test_list_dialogs_pagination(store: DialogStore) -> None:
    """Журнал от новых к старым, курсор ведёт на следующую страницу."""
    user = _user_id()
    dialog_ids = []
    for index in range(3):
        dialog_id = (await store.start_dialog(user)).dialog_id
        dialog_ids.append(dialog_id)
        await store.end_dialog(user, dialog_id, f"Итог {index}", None)

    page1, cursor = await store.list_dialogs(user, 2, None)
    assert [item["dialogId"] for item in page1] == [dialog_ids[2], dialog_ids[1]]
    assert cursor is not None

    page2, cursor2 = await store.list_dialogs(user, 2, cursor)
    assert [item["dialogId"] for item in page2] == [dialog_ids[0]]
    assert cursor2 is None


async def test_erase_user_removes_llm_checkpoints(store: DialogStore) -> None:
    """erase_user стирает и чекпоинты истории LLM диалогов пользователя."""
    user = _user_id()
    dialog_id = (await store.start_dialog(user)).dialog_id
    other_dialog_id = (await store.start_dialog(_user_id())).dialog_id
    async with store._session_factory() as session:
        from sqlalchemy import text

        for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
            await session.execute(text(f"CREATE TABLE IF NOT EXISTS {table} (thread_id TEXT)"))
            await session.execute(text(f"INSERT INTO {table} (thread_id) VALUES (:t)"), {"t": dialog_id})
            await session.execute(
                text(f"INSERT INTO {table} (thread_id) VALUES (:t)"), {"t": other_dialog_id}
            )
        await session.commit()

    await store.erase_user(user)

    async with store._session_factory() as session:
        from sqlalchemy import text

        for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
            remaining = await session.scalars(
                text(f"SELECT thread_id FROM {table}")
            )
            assert list(remaining) == [other_dialog_id]


async def test_erase_user_removes_dialogs_and_messages(store: DialogStore) -> None:
    """erase_user каскадно стирает диалоги и сообщения пользователя."""
    user = _user_id()
    dialog_id = (await store.start_dialog(user)).dialog_id
    await store.append_message(dialog_id, "user", "Секрет")
    await store.erase_user(user)
    assert await store.get_dialog(user, dialog_id) is None
    items, _ = await store.list_dialogs(user, 20, None)
    assert items == []

    async with store._session_factory() as session:
        from sqlalchemy import select

        from app.services.dialogs import Message

        remaining = await session.scalar(select(Message).where(Message.dialog_id == uuid.UUID(dialog_id)))
    assert remaining is None
