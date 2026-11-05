"""Итог разговора (add-mood-diary, D13): один связный текст в свободной форме, от второго лица (до 500 знаков).

Итог журнальный: он виден в записи журнала и служит входом итогов недели, в следующий разговор и в память (Cognee) не идёт
и не зависит от переключателя «Память». Хранится в сводке разговора и удаляется вместе с ним. Тексты итогов (в том числе ручные)
в журнал приложения не пишутся.

Итога нет у разговора, где человек сказал меньше 40 знаков, у разговора с кризисом и у не сохранённого разговора
(«Не сохранять этот разговор»: его текст в базу не пишется).
"""

import asyncio
import logging
import re
from typing import TYPE_CHECKING, Any, Literal

from app.clients.background_model import BackgroundModel, ModelError
from app.core.tracing import NullTracer, Tracer
from app.prompts.provider import PromptProvider, PromptUnavailable, ResolvedPrompt, prompt_metadata

if TYPE_CHECKING:
    from app.services.dialog_store import Dialog

logger = logging.getLogger("agent.recaps")

MIN_USER_CHARS = 40
RECAP_MAX = 500
# В модель уходит конец разговора: итогу хватает последних реплик.
PROMPT_MESSAGES = 40
PROMPT_CHARS = 6000

RecapSource = Literal["manual", "draft", "auto"]
RecapStatus = Literal["pending", "ready", "none"]

_FORBIDDEN = re.compile(r"\b(надо|должен|должна)\b", re.IGNORECASE)

def user_chars(dialog: "Dialog") -> int:
    """Сколько знаков сказал человек за весь разговор."""
    return sum(len(m.text.strip()) for m in dialog.messages if m.role == "user")


def eligible(dialog: "Dialog") -> bool:
    """Подводится ли итог для разговора: человек сказал не меньше 40 знаков, кризиса не было, разговор сохраняется. «Без памяти»
    на итог не влияет: журнальный итог не зависит от памяти."""
    return dialog.saved and not dialog.crisis_seen and user_chars(dialog) >= MIN_USER_CHARS


def build_messages(dialog: "Dialog", prompt: ResolvedPrompt) -> list[dict[str, str]]:
    lines: list[str] = []
    size = 0
    for message in reversed(dialog.messages[-PROMPT_MESSAGES:]):
        line = f"{'Человек' if message.role == 'user' else 'Рядом'}: {message.text.strip()}"
        size += len(line)
        if size > PROMPT_CHARS:
            break
        lines.append(line)
    body = "Разговор:\n" + "\n".join(reversed(lines))
    return [{"role": "system", "content": prompt.text}, {"role": "user", "content": body}]


def clean_recap(value: Any) -> str | None:
    """Итог, пришедший из модели или от человека, в каноничном виде; None, если он не годится."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text or len(text) > RECAP_MAX:
        return None
    return text


def clean_model_recap(value: Any) -> str | None:
    """То же, что `clean_recap`, но для ответа модели: советы со словом «надо» и «должен» отбраковываются."""
    text = clean_recap(value)
    if text is None or _FORBIDDEN.search(text):
        return None
    return text


def parse_model_reply(reply: str) -> str | None:
    return clean_model_recap(reply.strip().strip('"«»').strip())


async def make_recap(
    model: BackgroundModel | None,
    dialog: "Dialog",
    timeout: float,
    prompt_provider: PromptProvider | None = None,
    tracer: Tracer | None = None,
) -> str | None:
    """Итог разговора от модели с версией инструкции в отдельной трассе."""
    if model is None or prompt_provider is None:
        return None
    try:
        prompt = prompt_provider.resolve("agent.recap.system")
    except PromptUnavailable:
        logger.warning("recap prompt unavailable dialog=%s", dialog.id)
        return None
    messages = build_messages(dialog, prompt)
    trace = (tracer or NullTracer()).start_turn(
        name="dialog_recap",
        session_id=dialog.id,
        user_id=dialog.user_id,
        model=model.name,
        input=messages,
        metadata={"operation": "recap", **prompt_metadata(prompt)},
        prompt=prompt.prompt,
        tags=["background", "recap"],
    )
    try:
        try:
            reply = await asyncio.wait_for(model.complete(messages), timeout)
        except (ModelError, TimeoutError):
            logger.warning("recap model failed dialog=%s", dialog.id)
            trace.update(level="WARNING", status="модель не ответила")
            return None
        trace.update(output=reply)
        recap = parse_model_reply(reply)
        if recap is None:
            logger.info("recap rejected by the validator dialog=%s", dialog.id)
            trace.update(level="WARNING", status="ответ не прошёл проверку")
        return recap
    finally:
        trace.end()
