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
