"""Итог разговора (add-mood-diary, D13): один связный текст в свободной форме, от второго лица (до 500 знаков).

Итог журнальный: он виден в записи журнала и служит входом итогов недели, в следующий разговор и в память (Cognee) не идёт
и не зависит от переключателя «Память». Хранится в сводке разговора и удаляется вместе с ним. Тексты итогов (в том числе ручные)
в журнал приложения не пишутся.

Итога нет у разговора, где человек сказал меньше 40 знаков, у разговора с кризисом и у разговора «Без памяти» (его текст
не хранится дольше суток).
"""

import asyncio
import logging
import re
from typing import TYPE_CHECKING, Any, Literal

from app.clients.llm import ChatModel, ModelError

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

SYSTEM_PROMPT = (
    "Ты — Рядом, тёплый голосовой спутник для эмоциональной поддержки. Подведи итог разговора для самого человека: "
    "2–4 предложения связным текстом в свободной форме, без списков и заголовков. Что было в разговоре, что для человека стало главным, "
    "и, если о чём-то договорились, это тоже. Пиши от второго лица, на «ты», спокойно и бережно, без оценок и диагнозов, "
    "без советов со словом «надо» и «должен», без восклицательных знаков и эмодзи. Не цитируй реплики дословно, только своими словами. "
    f"Не длиннее {RECAP_MAX} знаков. Ответь только текстом итога."
)


def user_chars(dialog: "Dialog") -> int:
    """Сколько знаков сказал человек за весь разговор."""
    return sum(len(m.text.strip()) for m in dialog.messages if m.role == "user")


def eligible(dialog: "Dialog") -> bool:
    """Подводится ли итог для разговора: человек сказал не меньше 40 знаков, кризиса не было, разговор сохраняется."""
    return dialog.memory_mode == "on" and not dialog.crisis_seen and user_chars(dialog) >= MIN_USER_CHARS


def template_recap(dialog: "Dialog") -> str:
    """Детерминированный итог без модели: для `LLM_MODE=template` и разработки. Содержания разговора в нём нет."""
    return "Ты рассказал, что у тебя на душе, и мы поговорили об этом. Тебе важно, чтобы тебя услышали."


def build_messages(dialog: "Dialog") -> list[dict[str, str]]:
    lines: list[str] = []
    size = 0
    for message in reversed(dialog.messages[-PROMPT_MESSAGES:]):
        line = f"{'Человек' if message.role == 'user' else 'Рядом'}: {message.text.strip()}"
        size += len(line)
        if size > PROMPT_CHARS:
            break
        lines.append(line)
    body = "Разговор:\n" + "\n".join(reversed(lines))
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": body}]


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
    chat: ChatModel | None, dialog: "Dialog", timeout: float, template: bool = False
) -> str | None:
    """Итог разговора от модели; шаблонный — только в режиме `LLM_MODE=template` (`template`). None, если модели нет или она не
    ответила, или ответ не годится: тогда итог можно завести вручную."""
    if chat is None:
        return template_recap(dialog) if template else None
    try:
        reply = await asyncio.wait_for(chat.complete(build_messages(dialog)), timeout)
    except (ModelError, TimeoutError):
        logger.warning("recap model failed dialog=%s", dialog.id)
        return None
    recap = parse_model_reply(reply)
    if recap is None:
        logger.info("recap rejected by the validator dialog=%s", dialog.id)
    return recap
