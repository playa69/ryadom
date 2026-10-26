"""Извлекатель заметок: модель предлагает операции, код проверяет и применяет (PROTEUS-242, задачи 2.2 и 2.4, `design.md` D2).

Вход — новые реплики человека (уже замаскированные, 2.1), две последние реплики агента как контекст и живые заметки. Выход —
операции `add`, `update`, `delete`. Модель ошибается, поэтому всё идёт через `NotesService` (проверки «никогда», чувствительное по
согласию, лимит), плюс три проверки здесь:
- заметка опирается на цитату: `quote` должна встречаться в реплике человека (источник — только человек, I6), иначе `not_grounded`;
- `delete` и `update` — только по явной просьбе: признак просьбы в самой реплике проверяет код, а не модель;
- модель недоступна или ответила мусором — разговор и заметки не страдают, повтор на следующем проходе.
Тексты реплик и заметок в журнал не пишутся (I4).
"""

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.core.metrics import MEMORY_BLOCKED_TOTAL, MEMORY_EXTRACTION_FAILURES_TOTAL, MEMORY_EXTRACTION_TOTAL
from app.memory.errors import MemoryFull, MemoryServiceError, NoteNotFound, NoteRejected
from app.memory.masking import mask
from app.memory.notes import NotesService

logger = logging.getLogger("agent.memory")

PROMPT_DIR = Path(__file__).parent / "prompts"
_EXPLICIT = re.compile(
    r"забуд(?:ь|ьте)|убер(?:и|ите)|удал(?:и|ите)|не запоминай|не надо запоминать|стер(?:и|еть)|поправ(?:ь|ьте)|исправ(?:ь|ьте)|не (?:кот|кошка|так)",
    re.IGNORECASE,
)
_QUOTE_STRIP = re.compile(r"[\s\W_]+", re.UNICODE)


class Completer(Protocol):
    async def complete(self, messages: list[dict[str, str]]) -> str: ...


@dataclass
class Outcome:
    """Что получилось: числа и коды отказов, без текстов."""

    added: list[dict[str, Any]] = field(default_factory=list)
    updated: list[dict[str, Any]] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)  # коды причин

    @property
    def changed(self) -> bool:
        return bool(self.added or self.updated or self.deleted)


def _norm(text: str) -> str:
    return _QUOTE_STRIP.sub("", text.lower())


def is_explicit_request(texts: list[str]) -> bool:
    """В репликах есть явная просьба забыть, убрать или поправить."""
    return any(_EXPLICIT.search(text) for text in texts)


def _parse_ops(raw: str) -> list[dict[str, Any]]:
    """JSON из ответа модели (допускаем обрамление ```json и лишний текст вокруг)."""
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        raise ValueError("no json")
    data = json.loads(match.group(0))
    ops = data.get("ops") if isinstance(data, dict) else None
    if not isinstance(ops, list):
        raise ValueError("no ops")
    return [op for op in ops if isinstance(op, dict)]


def _grounded(quote: Any, human_texts: list[str]) -> bool:
    if not isinstance(quote, str) or len(_norm(quote)) < 3:
        return False
    needle = _norm(quote)
    return any(needle in _norm(text) for text in human_texts)


class NotesExtractor:
    """Один проход извлечения для одного человека."""

    def __init__(self, model: Completer, notes: NotesService) -> None:
        self._model = model
        self._notes = notes
        self._extract_prompt = (PROMPT_DIR / "extract.md").read_text(encoding="utf-8")
        self._instruction_prompt = (PROMPT_DIR / "instruction.md").read_text(encoding="utf-8")

    async def extract(
        self,
        user_id: str,
        human_texts: list[str],
        agent_context: list[str],
        dialog_id: str | None = None,
    ) -> Outcome:
        """Новые реплики человека → заметки. Сбой модели — пустой итог (повтор на следующем проходе)."""
        outcome = Outcome()
        texts = [mask(text) for text in human_texts if text.strip()]
        if not texts:
            return outcome
        live = await self._notes.list(user_id)
        explicit = is_explicit_request(texts)
        payload = self._payload(texts, [mask(t) for t in agent_context[-2:]], live)
        ops = await self._ask(self._extract_prompt, payload)
        if ops is None:
            return outcome
        await self._apply(user_id, ops, texts, live, explicit, dialog_id, outcome)
        return outcome

    async def instruct(self, user_id: str, request: str) -> Outcome:
        """Поле «Скажи, что поправить или убрать»: просьба человека — это и есть явное намерение."""
        outcome = Outcome()
        text = mask(request.strip())
        if not text:
            return outcome
        live = await self._notes.list(user_id)
        payload = self._payload([text], [], live)
        ops = await self._ask(self._instruction_prompt, payload)
        if ops is None:
            return outcome
        await self._apply(user_id, ops, [text], live, True, None, outcome)
        return outcome

    @staticmethod
    def _payload(texts: list[str], agent_context: list[str], live: list[dict[str, Any]]) -> str:
        notes = "\n".join(f"- id={note['id']} [{note['kind']}] {note['text']}" for note in live) or "(пока нет)"
        human = "\n".join(f"- {text}" for text in texts)
        context = "\n".join(f"- {text}" for text in agent_context) or "(нет)"
        return f"Текущие заметки:\n{notes}\n\nПоследние реплики помощника (контекст):\n{context}\n\nНовые реплики человека:\n{human}"

    async def _ask(self, system: str, user: str) -> list[dict[str, Any]] | None:
        try:
            raw = await self._model.complete([{"role": "system", "content": system}, {"role": "user", "content": user}])
            ops = _parse_ops(raw)
        except Exception as error:  # noqa: BLE001 - модель недоступна или ответила не тем: разговор не трогаем
            reason = "parse" if isinstance(error, ValueError) else "model"
            MEMORY_EXTRACTION_FAILURES_TOTAL.labels(reason).inc()
            MEMORY_EXTRACTION_TOTAL.labels("failed", reason).inc()
            logger.warning("memory extraction failed: %s", type(error).__name__)
            return None
        MEMORY_EXTRACTION_TOTAL.labels("done", "ok").inc()
        return ops

    async def _apply(
        self,
        user_id: str,
        ops: list[dict[str, Any]],
        human_texts: list[str],
        live: list[dict[str, Any]],
        explicit: bool,
        dialog_id: str | None,
        outcome: Outcome,
    ) -> None:
        live_ids = {note["id"] for note in live}
        for op in ops:
            kind_of_op = op.get("op")
            if kind_of_op in (None, "none"):
                continue
            if not _grounded(op.get("quote"), human_texts):
                self._block("not_grounded", outcome)
                continue
            try:
                if kind_of_op == "add":
                    note = await self._notes.add(
                        user_id, str(op.get("kind", "")), str(op.get("text", "")), dialog_id, _event_date(op.get("event_date"))
                    )
                    outcome.added.append(note)
                elif kind_of_op in ("update", "delete"):
                    if not explicit:
                        self._block("not_requested", outcome)
                        continue
                    note_id = str(op.get("id", ""))
                    if note_id not in live_ids:
                        self._block("unknown_note", outcome)
                        continue
                    if kind_of_op == "update":
                        outcome.updated.append(await self._notes.patch(user_id, note_id, str(op.get("text", ""))))
                    else:
                        await self._notes.delete(user_id, note_id)
                        outcome.deleted.append(note_id)
                else:
                    self._block("bad_op", outcome)
            except NoteRejected as error:
                outcome.blocked.append(error.reason or "rejected")  # метрика уже увеличена в `NotesService`
            except MemoryFull:
                self._block("full", outcome)
            except NoteNotFound:
                self._block("unknown_note", outcome)
            except MemoryServiceError as error:
                logger.warning("memory op failed code=%s", error.code)
                outcome.blocked.append(error.code.lower())

    @staticmethod
    def _block(reason: str, outcome: Outcome) -> None:
        MEMORY_BLOCKED_TOTAL.labels(reason).inc()
        outcome.blocked.append(reason)


def _event_date(value: Any) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else None
