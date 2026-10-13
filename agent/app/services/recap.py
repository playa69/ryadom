"""Итог разговора для экрана завершения: о чём говорили и к чему пришли, одно-два коротких предложения.

Человек видит итог уже вписанным в поле «Что забираешь с собой?» и может поправить или стереть его; сохраняется только то,
что он отправит при завершении (`takeaway`). Сам итог агент не хранит и в журнал не пишет: в нём личное.

Пишет итог та же текстовая модель прокси в РФ, что извлекает память (`MEMORY_LLM_*`, иначе `LLM_*`), так что текст разговора
не уходит туда, куда он не уходит и без итога. Итога нет (None):
- у разговора «Без памяти»: ему обещано «без сводок» (MEM-9);
- у разговора с кризисом: пересказывать его машинной фразой нельзя, как и извлекать из него память (I13);
- у слишком короткого разговора: подводить итог «привет» незачем;
- когда модели нет, она ошиблась или не уложилась в RECAP_TIMEOUT_SECONDS: поле остаётся пустым, как раньше.
"""

import asyncio
import logging
import re

from app.core.config import LlmSettings, MemorySettings
from app.memory.llm import ExtractionModel, MemoryLlm, MemoryModelError, build_proxy_llm
from app.services.dialog_store import Dialog

logger = logging.getLogger("agent.recap")

# Человек ждёт итог на экране завершения: дольше этого поле остаётся пустым, и он пишет сам. Меньше таймаута, с которым
# приложение зовёт агента (AGENT_TIMEOUT_MS, 10 с): медленная модель — это «итога нет», а не «агент недоступен».
RECAP_TIMEOUT_SECONDS = 8
RECAP_MAX_TOKENS = 256
# Итог — одна-две фразы, поле на экране помещает 500 знаков (InputLimit.TakeawayMax): длинный ответ обрезается по предложению.
RECAP_MAX_CHARS = 240
# Сколько последних знаков разговора видит модель: длинный разговор итожится по концу, где обычно и звучит вывод.
TRANSCRIPT_MAX_CHARS = 6000
# Меньше этого человек почти ничего не сказал (всего его реплик), и итог был бы пересказом приветствия.
MIN_USER_CHARS = 40

RECAP_PROMPT = (
    "Ты помогаешь человеку подвести итог разговора с собеседником «Рядом». Ниже расшифровка разговора: реплики человека и "
    "ответы собеседника.\n"
    "Напиши итог для самого человека: одно-два коротких предложения, всего не длиннее 200 знаков.\n"
    "- Первое предложение — о чём говорили. Начни его со слов «Говорили о» или «Говорили про».\n"
    "- Второе — к чему пришли: что стало понятнее, что человек решил или какой маленький шаг назвал сам. Начни его со слов "
    "«Пришли к тому, что» или «Решили». Если ни к чему не пришли, второго предложения не пиши.\n"
    "- Опирайся только на слова человека. Ничего не додумывай, не добавляй советов, оценок и диагнозов.\n"
    "- Пиши безлично, без «ты», «вы» и «я», и не угадывай род человека.\n"
    "- Только сам итог: без кавычек, списков, заголовков и пояснений."
)

_CYRILLIC = re.compile(r"[А-Яа-яЁё]")
_MARKUP = re.compile(r"[*_#`>]+")
_SENTENCE_END = re.compile(r"[.!?…](?=\s|$)")
_QUOTES = "\"'«»„“”"


def build_recap_llm(memory: MemorySettings, llm: LlmSettings) -> MemoryLlm | None:
    """Клиент модели итога: модель памяти с коротким ответом и таймаутом. None — итога не будет, агент работает дальше."""
    return build_proxy_llm(memory, llm, RECAP_MAX_TOKENS, RECAP_TIMEOUT_SECONDS, "recap")


def skip_reason(dialog: Dialog) -> str | None:
    """Почему у разговора не будет итога, или None, если будет."""
    if dialog.memory_mode == "off":
        return "memory_off"
    if dialog.crisis_seen:
        return "crisis"
    if sum(len(m.text) for m in dialog.messages if m.role == "user") < MIN_USER_CHARS:
        return "too_short"
    return None


def recap_messages(dialog: Dialog) -> list[dict[str, str]]:
    """Промпт итога и расшифровка: реплики по строке, от старых к новым, не длиннее TRANSCRIPT_MAX_CHARS (с конца)."""
    lines: list[str] = []
    size = 0
    for message in reversed(dialog.messages):
        speaker = "Человек" if message.role == "user" else "Рядом"
        line = f"{speaker}: {' '.join(message.text.split())}"
        if size + len(line) > TRANSCRIPT_MAX_CHARS and lines:
            break
        lines.append(line[-TRANSCRIPT_MAX_CHARS:])
        size += len(line) + 1
    transcript = "\n".join(reversed(lines))
    return [{"role": "system", "content": RECAP_PROMPT}, {"role": "user", "content": f"Разговор:\n{transcript}"}]


def clean_recap(answer: str) -> str | None:
    """Ответ модели как текст для поля: без разметки, кавычек вокруг и лишних пробелов, не длиннее RECAP_MAX_CHARS.
    Не по-русски или пусто — None."""
    text = " ".join(_MARKUP.sub("", answer).split())
    if len(text) >= 2 and text[0] in _QUOTES and text[-1] in _QUOTES:
        text = text[1:-1].strip()
    if not _CYRILLIC.search(text):
        return None
    if len(text) > RECAP_MAX_CHARS:
        head = text[:RECAP_MAX_CHARS]
        ends = [m.end() for m in _SENTENCE_END.finditer(head)]
        text = head[: ends[-1]] if ends else head[: head.rfind(" ")].rstrip(" ,;:—-") + "…"
    return text or None


async def make_recap(model: ExtractionModel | None, dialog: Dialog) -> str | None:
    """Итог разговора или None (см. описание модуля). Не бросает: экран завершения работает и без итога."""
    reason = "unavailable" if model is None else skip_reason(dialog)
    if reason is not None or model is None:
        logger.info("recap dialog=%s outcome=%s", dialog.id, reason)
        return None
    try:
        answer = await asyncio.wait_for(model.complete(recap_messages(dialog)), RECAP_TIMEOUT_SECONDS)
    except (MemoryModelError, TimeoutError) as error:
        code = error.code if isinstance(error, MemoryModelError) else "timeout"
        logger.warning("recap dialog=%s outcome=failed code=%s", dialog.id, code)
        return None
    recap = clean_recap(answer)
    logger.info("recap dialog=%s outcome=%s chars=%d", dialog.id, "ok" if recap else "empty", len(recap or ""))
    return recap
