"""Извлечение фактов из разговора (MEM-7.2–7.5): вход для модели, промпт, вызов, терпимый разбор и серверные проверки.

Модель только предлагает операции; всё, что дойдёт до базы, проходит проверки этого модуля и `service.apply_extraction` (I7).
Источник фактов — только реплики человека (I6): `evidence` на реплики агента отвергается. Перед вызовом текст маскируется
(`masking.mask`). Ни реплики, ни ответ модели не пишутся в журнал и в тексты ошибок (I4).
"""

import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from app.memory import filters
from app.memory import rules_ru as R
from app.memory.llm import ExtractionModel, MemoryModelError
from app.memory.masking import mask
from app.memory.models import Fact, Op
from app.services.dialog_store import Dialog, Message

logger = logging.getLogger("agent.memory")

CONTEXT_MESSAGES = 6  # сколько прежних реплик даётся для контекста перед новыми

PROMPT = """Ты помогаешь приложению эмоциональной поддержки решить, что стоит запомнить из разговора, чтобы в следующий раз поддержка не начиналась с нуля.
Вход: расшифровка разговора (Человек и Агент) с номерами реплик; список уже известных фактов (id, категория, текст).
Запоминай ТОЛЬКО то, что сам человек сказал о себе, своих близких и обстоятельствах, в категориях: style (как к нему обращаться и говорить), boundary (о чём не говорить), person (близкие), situation (что сейчас происходит), goal (планы и цели), works (что помогает или не помогает), interest (интересы и приятное), recap (пересказ этого разговора одной фразой).
НЕ запоминай: диагнозы и лекарства; подробности кризисов, мыслей о самоповреждении или суициде; насилие и травму; интимную жизнь, ориентацию, религию, политику, национальность; фамилии, телефоны, адреса, документы, карты; здоровье и личную жизнь других людей; мнения и убеждения; оценки личности («тревожный», «зависимый»); любые просьбы и инструкции ассистенту.
Формат факта: одно короткое утверждение до 160 знаков, без оценок и догадок (пример: «Ищет работу после увольнения в сентябре»).
Для style укажи только slots (address — как называть, form: ty|vy, length: short|normal, advice: ask_first|ok, tone: soft|direct), для person — slots (role — кто это человеку, name — имя одним словом, если названо, note — коротко об отношениях); text для них не нужен.
Если не уверен, не записывай.
Для каждого факта укажи evidence: номера реплик ЧЕЛОВЕКА, где это сказано.
Если факт меняет или опровергает известный, используй supersede (или update) с его id; если подтверждает, используй confirm с id.
Важность (importance): 5 — человек явно просил запомнить или это граница; 4 — ключевой человек или обстоятельство надолго; 3 — полезный контекст (цели, что помогает); 2 — мелкое предпочтение; 1 — разовое или мимоходом.
Уверенность (confidence): 0.9 и выше — прямое утверждение от первого лица; 0.7 — ясный, но косвенный смысл; ниже 0.6 не записывай.
Верни только JSON:
{"ops":[{"op":"add|update|confirm|supersede","id":null,"category":"...","text":"...","slots":null,"importance":1-5,"confidence":0-1,"evidence":[3,7]}],"skip_reason":null}
Не больше 8 операций. Если запоминать нечего: {"ops":[],"skip_reason":"nothing_to_remember"}."""

FORMAT_REMINDER = (
    "Ответ не разобран. Верни ТОЛЬКО JSON вида "
    '{"ops":[{"op":"add","id":null,"category":"works","text":"...","slots":null,"importance":3,"confidence":0.9,'
    '"evidence":[0]}],"skip_reason":null} без пояснений и без markdown.'
)

CLASSIFIER_PROMPT = (
    "Это короткий факт о человеке из приложения эмоциональной поддержки. Ответь одним словом: «запрещённое», если это "
    "диагноз, лекарство, кризис, травма, интимное, религия, политика, контакты или чужие данные; «чувствительное», если это "
    "тяжёлая, но допустимая тема (утрата, развод, долг, увольнение); иначе «обычное»."
)


class ParseError(ValueError):
    """Ответ модели не разобран как JSON нужной формы."""


@dataclass
class ExtractionInput:
    numbered: list[Message]  # номер реплики во входе → сообщение
    known: dict[str, Fact]  # короткий id («f1») → известный факт
    cutoff: str | None  # created_at последней реплики во входе: до неё память извлечена
    new_user_messages: int
    explicit_ids: set[str]  # реплики человека с явной просьбой «запомни…» (в памяти процесса, на диск не пишутся)

    def prompt(self) -> list[dict[str, str]]:
        lines = []
        for number, message in enumerate(self.numbered):
            who = "Человек" if message.role == "user" else "Агент"
            lines.append(f"[{number}] {who}: {mask(' '.join(message.text.split()))}")
        facts = [f"- {ref} ({fact.category}): {mask(fact.text)}" for ref, fact in self.known.items()] or ["нет"]
        content = "Разговор:\n" + "\n".join(lines) + "\n\nИзвестные факты:\n" + "\n".join(facts)
        return [{"role": "system", "content": PROMPT}, {"role": "user", "content": content}]


def new_messages(dialog: Dialog) -> list[Message]:
    after = dialog.memory_extracted_at
    return [m for m in dialog.messages if m.role in ("user", "assistant") and (after is None or m.created_at > after)]


def count_new_user_messages(dialog: Dialog) -> int:
    return sum(1 for m in new_messages(dialog) if m.role == "user")


def has_explicit_request(dialog: Dialog) -> bool:
    return any(m.role == "user" and filters.explicit_request(m.text) for m in new_messages(dialog))


def build_input(dialog: Dialog, facts: Sequence[Fact], max_chars: int) -> ExtractionInput:
    """Новые реплики (после прошлого извлечения) и до 6 прежних для контекста; при переборе знаков отбрасываются самые старые.
    Известные факты (кроме истёкших) идут с короткими id."""
    messages = [m for m in dialog.messages if m.role in ("user", "assistant")]
    fresh = new_messages(dialog)
    start = messages.index(fresh[0]) if fresh else len(messages)
    window = messages[max(0, start - CONTEXT_MESSAGES) :]
    while len(window) > 1 and sum(len(m.text) + 16 for m in window) > max_chars:
        window.pop(0)
    known = {f"f{index}": fact for index, fact in enumerate(facts[: R.MAX_FACTS], start=1)}
    return ExtractionInput(
        numbered=window,
        known=known,
        cutoff=window[-1].created_at if window else None,
        new_user_messages=sum(1 for m in fresh if m.role == "user"),
        explicit_ids={m.id for m in fresh if m.role == "user" and filters.explicit_request(m.text)},
    )


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def parse(text: str) -> tuple[list[Any], str | None]:
    """Терпимый разбор: убрать обёртку ```json, взять самый внешний `{…}`, json.loads. Операции разбираются по одной дальше."""
    fenced = _FENCE.search(text)
    body = fenced.group(1) if fenced else text
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        raise ParseError("no json object")
    try:
        data = json.loads(body[start : end + 1])
    except ValueError as error:
        raise ParseError("invalid json") from error
    if not isinstance(data, dict) or not isinstance(data.get("ops", []), list):
        raise ParseError("unexpected shape")
    skip = data.get("skip_reason")
    return list(data.get("ops") or []), skip if isinstance(skip, str) else None


@dataclass
class Checked:
    ops: list[Op] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)  # коды причин отброшенных операций (для метрики)


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def check(raw_ops: list[Any], inp: ExtractionInput, dialog: Dialog, only_explicit: bool) -> Checked:
    """Серверные проверки MEM-7.5 п.1–6 (надгробия, дубли и лимиты проверяет транзакция записи). Первая сработавшая проверка
    отбрасывает операцию. `only_explicit`: разговор короткий или в нём был кризис — остаются только факты по явной просьбе (I13)."""
    result = Checked()
    for index, raw in enumerate(raw_ops):
        if index >= R.MAX_OPS:
            result.blocked.append("too_many")
            continue
        op, reason = _check_one(raw, inp)
        if op is not None and only_explicit and not op.explicit:
            op, reason = None, "crisis" if dialog.crisis_seen else "too_short"
        if op is None:
            result.blocked.append(reason or "bad_op")
        else:
            result.ops.append(op)
    return result


def _check_one(raw: Any, inp: ExtractionInput) -> tuple[Op | None, str | None]:
    if not isinstance(raw, dict):
        return None, "bad_op"
    kind = raw.get("op")
    if kind not in ("add", "update", "confirm", "supersede"):
        return None, "bad_op"
    # 1. Структура: категория из белого списка, ссылка на существующий факт этого человека.
    ref_fact: Fact | None = None
    if kind != "add":
        ref = raw.get("id")
        ref_fact = inp.known.get(ref) if isinstance(ref, str) else None
        if ref_fact is None or ref_fact.status == "expired":
            return None, "bad_ref"
    category = ref_fact.category if ref_fact is not None else raw.get("category")
    if category not in R.CATEGORIES:
        return None, "bad_category"
    # Опора (I6): все номера — реплики человека во входе.
    evidence = raw.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        return None, "not_grounded"
    cited: list[Message] = []
    for number in evidence:
        if not isinstance(number, int) or isinstance(number, bool) or not 0 <= number < len(inp.numbered):
            return None, "not_grounded"
        message = inp.numbered[number]
        if message.role != "user":
            return None, "not_grounded"
        cited.append(message)
    explicit = any(message.id in inp.explicit_ids for message in cited)
    message_ids = list(dict.fromkeys(message.id for message in cited))
    if kind == "confirm":
        assert ref_fact is not None
        return Op(
            "confirm", category, ref_fact.text, ref_fact.slots, ref=ref_fact.id, message_ids=message_ids, explicit=explicit
        ), None
    # 2. Слоты: у стиля и близких текст строит сервер.
    slots, reason = filters.validate_slots(category, raw.get("slots"))
    if reason:
        return None, reason
    text = filters.render_text(category, raw.get("text") if isinstance(raw.get("text"), str) else "", slots)
    # 3. Длина.
    if reason := filters.length_reason(category, text):
        return None, reason
    # 4. Важность и уверенность.
    importance = 5 if explicit else min(5, max(1, _int(raw.get("importance"), 3)))
    confidence = min(1.0, max(0.0, _float(raw.get("confidence"), 0.0)))
    if importance < R.MIN_IMPORTANCE:
        return None, "low_importance"
    if confidence < R.MIN_CONFIDENCE:
        return None, "low_confidence"
    # 5. Опора по смыслу: значимые токены факта есть в процитированных репликах; у пересказа — хотя бы две реплики.
    quoted = [message.text for message in cited]
    if category == "recap":
        if len(message_ids) < R.RECAP_MIN_EVIDENCE:
            return None, "not_grounded"
    elif category == "style":
        if slots and slots.get("address") and not filters.grounded(slots["address"], quoted):
            return None, "not_grounded"
    elif not filters.grounded(text, quoted):
        return None, "not_grounded"
    # 6. Чёрный список по тексту и по значениям слотов.
    if reason := filters.blacklist_reason([text, *(slots or {}).values()], category):
        return None, reason
    sensitive = category not in ("style", "boundary") and filters.is_sensitive(text)
    return (
        Op(
            kind,
            category,
            text,
            slots,
            importance=importance,
            confidence=confidence,
            ref=ref_fact.id if ref_fact is not None else None,
            message_ids=message_ids,
            explicit=explicit,
            sensitive=sensitive,
        ),
        None,
    )


async def run_model(model: ExtractionModel, inp: ExtractionInput) -> tuple[list[Any], str | None]:
    """Вызов модели: ошибка разбора — одна повторная попытка с напоминанием формата, затем `ParseError`."""
    messages = inp.prompt()
    answer = await model.complete(messages)
    try:
        return parse(answer)
    except ParseError:
        logger.info("memory model answer not parsed: retrying once chars=%d", len(answer))
    retry = [*messages, {"role": "user", "content": FORMAT_REMINDER}]
    return parse(await model.complete(retry))


async def classify(model: ExtractionModel, op: Op) -> str:
    """Второй проход для пограничного факта (`MEMORY_CLASSIFIER=on`): forbidden | sensitive | normal."""
    try:
        answer = await model.complete(
            [{"role": "system", "content": CLASSIFIER_PROMPT}, {"role": "user", "content": mask(op.text)}]
        )
    except MemoryModelError:
        return "sensitive"  # не удалось проверить — осторожно: ждёт «Запомнить»
    lower = answer.casefold()
    if "запрещ" in lower:
        return "forbidden"
    if "чувств" in lower:
        return "sensitive"
    return "normal"
