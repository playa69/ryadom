"""Хранилище диалогов: старт нового разговора и возобновление (specs/agent-api «Начало и возобновление диалога»)."""

import uuid
from datetime import UTC, datetime, timedelta

from app.services.dialog_store import DialogStore


def test_new_start_closes_a_dialog_with_messages_and_tells_its_socket() -> None:
    store = DialogStore()
    user = str(uuid.uuid4())
    first, _, _ = store.start(user)
    store.add_message(first, "user", "Мне сегодня тревожно")
    store.add_message(first, "assistant", "Я рядом.")
    told: list[dict] = []
    first.on_replaced = told.append  # сессия сокета узнаёт, что диалог завершён с другого экрана

    second, resumed, _ = store.start(user, new=True)

    assert resumed is False and second.id != first.id
    assert first.ended_at is not None and first.summary is not None
    assert first.summary["title"] == "Мне сегодня тревожно"
    assert second.ended_at is None and second.messages == []
    assert store.open_dialog(user) is second  # открытый один
    assert told == [first.summary]  # сокет прежнего диалога получил сводку и закроется


def test_plain_start_stays_idempotent() -> None:
    store = DialogStore()
    user = str(uuid.uuid4())
    first, _, _ = store.start(user)
    again, resumed, _ = store.start(user)
    assert again is first and resumed is True
    assert first.ended_at is None


def test_new_start_reuses_a_dialog_without_messages() -> None:
    store = DialogStore()
    user = str(uuid.uuid4())
    first, _, _ = store.start(user)
    told: list[dict] = []
    first.on_replaced = told.append
    again, resumed, _ = store.start(user, new=True)
    assert again is first and resumed is False and again.greeting == "Я рядом. С чего начнём?"
    assert first.ended_at is None and told == []  # сокет такого диалога никто не закрывает


def test_hours_count_from_the_last_activity_of_any_dialog() -> None:
    store = DialogStore()
    user = str(uuid.uuid4())
    old, _, _ = store.start(user)
    store.add_message(old, "user", "давно")
    store.end(old, None, None)
    old.ended_at = (datetime.now(UTC) - timedelta(hours=72)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    _, _, hours = store.start(user)
    assert hours == 72  # единственная активность: давно завершённый разговор

    open_dialog = store.open_dialog(user)
    assert open_dialog is not None and open_dialog is not old
    store.add_message(open_dialog, "user", "только что")  # человек говорил в открытом диалоге минуту назад
    _, resumed, hours = store.start(user)
    assert resumed and hours == 0
    _, resumed, hours = store.start(user, new=True)
    assert not resumed and hours == 0  # завершая открытый, «давно не виделись» от старого разговора не считаем


class _MemorySpy:
    """MemoryLink-заглушка: записывает, у каких диалогов спросили извлечение."""

    def __init__(self) -> None:
        self.ended: list[str] = []

    def dialog_ended(self, dialog) -> None:
        self.ended.append(dialog.id)


def _old(stamp: str, seconds: int) -> str:
    point = datetime.fromisoformat(stamp.replace("Z", "+00:00")) - timedelta(seconds=seconds)
    return point.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def test_stale_socketless_dialog_is_ended_and_goes_to_memory() -> None:
    """Открытый диалог без сокета и без активности дольше срока завершается сам и уходит в память (извлечение)."""
    store = DialogStore(idle_end_seconds=300)
    memory = _MemorySpy()
    store.memory = memory
    user = str(uuid.uuid4())
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "поговорили и человек пропал")
    store.socket_closed(dialog)  # вкладку закрыли, «завершить» никто не нажал
    dialog.socket_closed_at = _old(dialog.socket_closed_at, 301)

    assert store.end_stale(datetime.now(UTC)) == 1
    assert dialog.ended_at is not None and dialog.summary is not None
    assert memory.ended == [dialog.id]  # извлечение поставлено


def test_stale_end_keeps_live_fresh_and_empty_dialogs() -> None:
    store = DialogStore(idle_end_seconds=300)
    memory = _MemorySpy()
    store.memory = memory
    user = str(uuid.uuid4())

    live, _, _ = store.start(user)
    store.add_message(live, "user", "я тут, просто думаю")
    store.socket_opened(live)  # сокет жив — не трогаем, сколько бы ни молчал

    ended = store.end_stale(datetime.now(UTC) + timedelta(hours=1))
    assert ended == 0 and live.ended_at is None and memory.ended == []

    # А вот свежий (говорили минуту назад) — тоже не трогаем при обычном проходе
    store2 = DialogStore(idle_end_seconds=300)
    memory2 = _MemorySpy()
    store2.memory = memory2
    fresh, _, _ = store2.start(user)
    store2.add_message(fresh, "user", "только что")
    store2.socket_closed(fresh)
    assert store2.end_stale(datetime.now(UTC)) == 0
    assert fresh.ended_at is None and memory2.ended == []


def test_stale_end_disabled_at_zero() -> None:
    store = DialogStore(idle_end_seconds=0)
    memory = _MemorySpy()
    store.memory = memory
    user = str(uuid.uuid4())
    dialog, _, _ = store.start(user)
    store.add_message(dialog, "user", "давно")
    dialog.messages[0].created_at = _old(dialog.messages[0].created_at, 10_000)
    assert store.end_stale(datetime.now(UTC)) == 0
    assert dialog.ended_at is None


def test_voice_name_follows_the_gender_choice():
    """Конкретный голос Gemini (профиль): задаётся вместе с родом, сбрасывается стартом без имени и кадром set_voice."""
    store = DialogStore()
    dialog, _, _ = store.start("u1", "female", False, "on", "Aoede")
    assert (dialog.voice, dialog.voice_name, dialog.voice_key) == ("female", "Aoede", "Aoede")

    # Старт без голоса (кадр пропущен) держит прошлый выбор целиком.
    again, _, _ = store.start("u1")
    assert again.voice_key == "Aoede"

    # Род без имени: человек вернулся к голосу рода.
    dialog, _, _ = store.start("u1", "female")
    assert (dialog.voice_name, dialog.voice_key) == (None, "female")

    store.start("u1", "male", False, "on", "Puck")
    dialog = store.open_dialog("u1")
    store.set_voice(dialog, "female")  # выбор рода прямо в диалоге
    assert (dialog.voice, dialog.voice_name, dialog.voice_key) == ("female", None, "female")
