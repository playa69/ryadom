"""Извлекатель заметок на фиктивной модели (PROTEUS-242, задачи 2.2 и 2.4): проверки кода вокруг модели. Тексты выдуманы.

Качество самой модели проверяет `scripts/memory_golden.py` на настоящей модели (прокси программы)."""

import json
import uuid
from typing import Any

from app.memory.extractor import NotesExtractor, is_explicit_request
from app.memory.notes import NotesService
from tests.conftest import FakePromptProvider
from tests.fake_db import FakeDialogDatabase


class FakeModel:
    def __init__(self, answer: Any = None, fail: bool = False) -> None:
        self.answer, self.fail = answer, fail
        self.seen: list[list[dict[str, str]]] = []

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.seen.append(messages)
        if self.fail:
            raise RuntimeError("model down")
        return self.answer if isinstance(self.answer, str) else json.dumps(self.answer, ensure_ascii=False)


def setup(answer: Any = None, fail: bool = False, max_notes: int = 50) -> tuple[NotesExtractor, NotesService, FakeModel]:
    FakeDialogDatabase.reset()
    db = FakeDialogDatabase("extractor")
    db.open()
    notes = NotesService(lambda: db, max_notes)
    model = FakeModel(answer, fail)
    return NotesExtractor(model, notes, FakePromptProvider()), notes, model


def user() -> str:
    return str(uuid.uuid4())


async def test_adds_a_grounded_note() -> None:
    extractor, notes, _ = setup({"ops": [{"op": "add", "kind": "situation", "text": "Работает в продажах", "quote": "работаю в продажах"}]})
    u = user()
    outcome = await extractor.extract(u, ["Я работаю в продажах уже пять лет"], ["Расскажи о себе"])
    assert [n["text"] for n in outcome.added] == ["Работает в продажах"]
    assert [n["text"] for n in await notes.list(u)] == ["Работает в продажах"]


async def test_note_without_a_quote_from_the_human_is_dropped() -> None:
    """Источник — только реплики человека: цитаты нет в его словах (модель взяла из реплики агента) — не записываем."""
    extractor, notes, _ = setup({"ops": [{"op": "add", "kind": "situation", "text": "Любит море", "quote": "ты любишь море"}]})
    u = user()
    outcome = await extractor.extract(u, ["Сегодня тяжёлый день"], ["Ты любишь море?"])
    assert outcome.added == [] and outcome.blocked == ["not_grounded"]
    assert await notes.list(u) == []


async def test_forbidden_note_from_the_model_is_blocked_by_code() -> None:
    extractor, notes, _ = setup({"ops": [{"op": "add", "kind": "situation", "text": "Принимает антидепрессанты", "quote": "принимаю антидепрессанты"}]})
    u = user()
    outcome = await extractor.extract(u, ["Я принимаю антидепрессанты"], [])
    assert outcome.blocked == ["medication"] and await notes.list(u) == []


async def test_delete_only_on_explicit_request() -> None:
    extractor, notes, model = setup()
    u = user()
    note = await notes.add(u, "interest", "Живёт с котом Барсиком")
    model.answer = {"ops": [{"op": "delete", "id": note["id"], "quote": "у меня кот"}]}
    outcome = await extractor.extract(u, ["Вечером играю, у меня кот"], [])
    assert outcome.deleted == [] and outcome.blocked == ["not_requested"]  # просьбы в реплике нет — модель не может удалять

    model.answer = {"ops": [{"op": "delete", "id": note["id"], "quote": "забудь про кота"}]}
    outcome = await extractor.extract(u, ["Забудь про кота, пожалуйста"], [])
    assert outcome.deleted == [note["id"]] and await notes.list(u) == []


async def test_update_on_explicit_request() -> None:
    extractor, notes, _ = setup()
    u = user()
    note = await notes.add(u, "interest", "Живёт с котом Барсиком")
    extractor._model.answer = {"ops": [{"op": "update", "id": note["id"], "text": "Живёт с кошкой Муськой", "quote": "не кот, а кошка"}]}  # type: ignore[attr-defined]
    outcome = await extractor.extract(u, ["Поправь: у меня не кот, а кошка Муська"], [])
    assert [n["text"] for n in outcome.updated] == ["Живёт с кошкой Муськой"]


async def test_unknown_note_id_is_not_touched() -> None:
    extractor, notes, _ = setup({"ops": [{"op": "delete", "id": "nope", "quote": "забудь это"}]})
    outcome = await extractor.extract(user(), ["Забудь это"], [])
    assert outcome.blocked == ["unknown_note"]


async def test_model_down_or_garbage_does_not_break() -> None:
    extractor, notes, _ = setup(fail=True)
    u = user()
    assert (await extractor.extract(u, ["Работаю в продажах"], [])).changed is False
    extractor2, _, _ = setup("не JSON вовсе")
    assert (await extractor2.extract(u, ["Работаю в продажах"], [])).changed is False


async def test_phone_does_not_leave_the_process() -> None:
    extractor, _, model = setup({"ops": []})
    await extractor.extract(user(), ["Мой телефон +7 (999) 123-45-67, но я не об этом"], [])
    sent = json.dumps(model.seen, ensure_ascii=False)
    assert "123-45-67" not in sent and "[телефон]" in sent


async def test_json_in_a_code_fence_and_none_ops() -> None:
    answer = '```json\n{"ops":[{"op":"none"},{"op":"add","kind":"name","text":"Зовут Алекс","quote":"меня зовут Алекс"}]}\n```'
    extractor, notes, _ = setup(answer)
    u = user()
    outcome = await extractor.extract(u, ["Меня зовут Алекс"], [])
    assert [n["text"] for n in outcome.added] == ["Зовут Алекс"]


async def test_limit_only_allows_nothing_new() -> None:
    extractor, notes, _ = setup({"ops": [{"op": "add", "kind": "situation", "text": "Новая заметка", "quote": "новая заметка"}]}, max_notes=1)
    u = user()
    await notes.add(u, "situation", "Старая заметка")
    outcome = await extractor.extract(u, ["Вот новая заметка для вас"], [])
    assert outcome.blocked == ["full"] and len(await notes.list(u)) == 1


async def test_instruction_field_applies_a_request() -> None:
    extractor, notes, model = setup()
    u = user()
    note = await notes.add(u, "boundary", "Не хочет обсуждать отца")
    model.answer = {"ops": [{"op": "delete", "id": note["id"], "quote": "убери тему про отца"}]}
    outcome = await extractor.instruct(u, "Убери тему про отца")
    assert outcome.deleted == [note["id"]]


def test_explicit_request_detection() -> None:
    assert is_explicit_request(["Забудь, что я говорил про работу"])
    assert is_explicit_request(["Не запоминай это"])
    assert not is_explicit_request(["Сегодня гулял с собакой"])


async def test_added_note_remembers_the_fingerprint_of_its_source_reply() -> None:
    """Удалённая заметка подавляет реплику, на которой выросла (D15): хранится отпечаток, не текст."""
    from app.memory.suppress import fingerprint

    reply = "Не хочу говорить про отца, он меня бросил"
    extractor, notes, _ = setup({"ops": [{"op": "add", "kind": "boundary", "text": "Не хочет обсуждать отца", "quote": "не хочу говорить про отца"}]})
    u = user()
    await extractor.extract(u, [reply], [], "dlg-1")
    note = (await notes.list(u))[0]
    await notes.delete(u, note["id"])
    assert notes._db().suppressed_hashes(u) == {fingerprint(reply)}


async def test_memory_operations_link_prompt_versions_without_note_metadata() -> None:
    """`openspec/changes/add-langfuse-prompt-management`, «Видимость использованной версии»."""
    from tests.conftest import RecordingTracer

    provider = FakePromptProvider(
        versions={"agent.memory.extract.system": 8, "agent.memory.instruction.system": 9}
    )
    tracer = RecordingTracer()
    _, notes, model = setup({"ops": []})
    extractor = NotesExtractor(model, notes, provider, tracer)
    user_id = user()
    await extractor.extract(user_id, ["Синтетическая реплика"], [], "dialog-1")
    await extractor.instruct(user_id, "Синтетическая просьба")
    extract, instruct = tracer.turns
    assert extract["name"] == "memory_extract" and extract["session_id"] == "dialog-1"
    assert extract["prompt"] == {"name": "agent.memory.extract.system", "version": 8}
    assert instruct["name"] == "memory_instruct" and instruct["session_id"] == "memory"
    assert instruct["prompt"] == {"name": "agent.memory.instruction.system", "version": 9}
    assert all(turn["user_id"] == user_id for turn in tracer.turns)
    assert "Синтетическая" not in str(extract["metadata"]) + str(instruct["metadata"])


async def test_unavailable_memory_prompt_does_not_call_the_model() -> None:
    """`openspec/changes/add-langfuse-prompt-management`, «Работа только с инструкциями Langfuse»."""
    provider = FakePromptProvider(
        unavailable={"agent.memory.extract.system", "agent.memory.instruction.system"}
    )
    _, notes, model = setup({"ops": []})
    extractor = NotesExtractor(model, notes, provider)
    user_id = user()
    extracted = await extractor.extract(user_id, ["Работаю"], [])
    instructed = await extractor.instruct(user_id, "Убери заметку")
    assert extracted.failed and instructed.failed
    assert model.seen == []
