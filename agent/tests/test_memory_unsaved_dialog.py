"""Не сохраняемый разговор не попадает в память (`add-unsaved-dialog`, «Не сохраняемый разговор не попадает в память»,
сценарий «Память и поиск включены», задача 1.2).

Включены и «Память», и «Опираться на прошлые разговоры»; человек поставил галочку «Не сохранять этот разговор», рассказал о себе и
закончил разговор. Заметок, документа в Cognee и записей в `memory_outbox` нет, а следующий разговор не находит ничего ни в блоке памяти,
ни в поиске по прошлым разговорам. Модель, Cognee и база — двойники; реплики выдуманные.
"""

import pytest

from app.services.dialog_store import Dialog, Message, now_iso
from tests.test_memory_cognee_backend import CONSENT, dataset_name, dialog, stored_dialog, uid
from tests.test_memory_flow import ADD_WORK, build

HUMAN = [("user", "Я работаю в продажах и люблю гулять у воды"), ("assistant", "Понимаю"), ("user", "Сестра Маша меня поддерживает")]
TRAP = "Выдуманная находка из прошлого разговора"


@pytest.fixture(autouse=True)
def no_index_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.memory.cognee_backend.INDEX_DELAY_SECONDS", 0)


def unsaved(user: str, dialog_id: str = "") -> Dialog:
    """Завершённый разговор «Не сохранять этот разговор» со словами человека (пока он шёл, они лежали в памяти процесса)."""
    messages = [Message(id=str(i), role=role, text=text, created_at=now_iso()) for i, (role, text) in enumerate(HUMAN)]
    made = Dialog(id=dialog_id or uid(), user_id=user, started_at=now_iso(), ended_at=now_iso(), messages=messages, saved=False)
    assert made.memory_mode == "off"  # память у такого разговора выключена всегда
    return made


async def test_nothing_of_an_unsaved_dialog_reaches_notes_cognee_or_the_outbox() -> None:
    service, model, db = build(ADD_WORK)
    fake = service._client
    user = uid()
    await service.update_settings(user, True, CONSENT)  # «Память» включена, «Опираться на прошлые разговоры» включено по умолчанию
    assert (await service.get_memory(user))["chatSearchEnabled"] is True
    await service.drain()
    fake.recalls.clear()
    pending_before = db.outbox_pending()
    current = unsaved(user)

    for _, text in HUMAN:
        service.user_message(current, text)  # реплики по ходу разговора
    service.dialog_ended(current)  # и завершение
    await service.drain()
    await service.outbox.tick()

    assert model.seen == [] and db.list_notes(user) == []  # заметки не извлекались ни по ходу, ни в финале
    assert fake.recalls == []  # реплики не уходили в поиск по Cognee
    assert fake.documents.get(dataset_name(user), {}) == {}  # документа этого разговора в Cognee нет
    assert db.outbox_pending() == pending_before  # и записей в очереди памяти по нему нет
    assert [row for row in db.outbox_due("9999", 50) if row[2] in ("index_dialog", "reindex_dialog")] == []


async def test_the_next_dialog_finds_nothing_from_an_unsaved_one() -> None:
    service, _, db = build(ADD_WORK)
    fake = service._client
    fake.recall_text = TRAP  # любой поиск по Cognee вернул бы находку: значит, поиска по этому разговору быть не должно
    user = uid()
    await service.update_settings(user, True, CONSENT)
    await service.drain()
    current = unsaved(user)
    service.user_message(current, HUMAN[0][1])
    service.dialog_ended(current)
    await service.drain()

    assert service.brief(current) == ""  # блока памяти у самого разговора нет
    nxt = dialog(user)  # следующий обычный разговор человека
    text = service.brief(nxt)
    assert "Сестра" not in text and "продажах" not in text and TRAP not in text  # ничего из несохранённого в сводку не просочилось


async def test_the_rebuild_of_the_index_skips_the_mark() -> None:
    service, _, db = build(ADD_WORK)
    fake = service._client
    user = uid()
    await service.update_settings(user, True, CONSENT)
    kept = stored_dialog(db, user, HUMAN)
    mark = stored_dialog(db, user, [], mode="off", saved=False)  # пометка в журнале: строка без текста
    hidden = stored_dialog(db, user, HUMAN, mode="off", saved=False)  # даже если бы текст остался, в индекс он не идёт
    assert db.indexable_dialog_ids(user) == [kept]
    assert db.dialog_for_index(mark) is None and db.dialog_for_index(hidden) is None

    await service.update_settings(user, None, None, chat_search_enabled=False)
    await service.drain()
    await service.outbox.tick()
    await service.update_settings(user, None, None, chat_search_enabled=True)  # включение пересобирает индекс из журнала
    await service.drain()
    while await service.outbox.tick():
        pass
    names = sorted(name for name, _ in fake.documents[dataset_name(user)].values())
    assert names == [f"dialog-{kept}"]
