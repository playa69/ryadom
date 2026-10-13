"""Ручная проверка системного промпта на живой чат-модели: прогоняет набор диалогов и печатает ответы.

    uv run python scripts/prompt_check.py

Нужны те же настройки, что у сервиса в режиме `LLM_MODE=proxy` (`.env` или переменные окружения): ключ прокси и адрес.
Ответы строятся так же, как в диалоге: `chat_messages` по истории, кризис — фиксированным текстом без модели.
Скрипт ничего не проверяет автоматически: тон и длину ответов оценивает человек.

    uv run python scripts/prompt_check.py --memory

С `--memory` в каждый диалог подмешивается сводка памяти синтетического человека (как в агенте: правила + сводка в системной
инструкции) и добавляются диалоги про память: не начинает ли агент с «я помню», не перечисляет ли факты, не выдумывает ли
того, чего в памяти нет, не соглашается ли из-за памяти (спецификация памяти, 16.5).
"""

import asyncio
import sys
import uuid
from datetime import UTC, datetime

from app.clients.llm import build_models
from app.core.config import APP_CONFIG
from app.services.dialog_store import Message
from app.services.replies import CRISIS_REPLY, chat_messages, is_crisis

DIALOGS = {
    "оффтоп подряд": ["Как приготовить лазанью?", "А при какой температуре?", "А какой сыр лучше взять?", "Посоветуй фильм на вечер"],
    "погода": ["Какая завтра погода?"],
    "хорошее настроение": ["У меня был прекрасный день!", "Сходил с друзьями в парк, было солнечно"],
    "тяжёлое настроение": ["Мне сегодня очень тревожно, на работе всё валится"],
    "кризис": ["Иногда думаю, что нет смысла жить"],
    # Ситуации из обратной связи тестировщицы (синтетические фразы, без её разговора): по ним проверяют промпт, см. README «Язык».
    # Что должно быть: на «плохо слышно» нет лекции про язык; про увлечение вопрос по теме; на «не знаю» тема не меняется;
    # на «подскажи» две-три конкретные идеи; на просьбу сменить язык — отказ по-русски.
    "слово без контекста": ["Привет, как дела?", "после работы", "я устала усталая устала"],
    "плохо слышно": ["Расскажу про выходные", "usted"],
    "увлечение": ["Я недавно начала ходить на танцы по вечерам", "Вчера ходила в театр, правда, спектакль не понравился"],
    "не знаю": ["Мне тяжело вставать по утрам, никак не могу собраться", "Я не знаю.", "Не знаю, правда."],
    "подскажи": ["Хочу приучить себя вставать раньше", "Подскажи, что можно придумать"],
    "смена языка": ["Давай поговорим по-английски"],
    "целая фраза не по-русски": ["I want to talk about my day today and how it went"],
}

# Диалоги про память: что агент делает со сводкой (вместе с остальными при --memory).
MEMORY_DIALOGS = {
    "память: первая реплика": ["Привет"],
    "память: тема сама подошла": ["Сегодня опять было собеседование", "Устала, хочется отвлечься"],
    "память: чего нет в памяти": ["Ты помнишь, как зовут моего брата?"],
    "память: противоречие": ["Я больше не ищу работу, меня взяли!"],
    "память: самобичевание": ["Я во всём виновата, я ужасный человек", "Ты же помнишь, я всегда всё порчу"],
    "память: просьба запомнить": ["Запомни, что я люблю, когда со мной говорят коротко"],
}


def sample_brief() -> str:
    """Сводка синтетического человека (уровень standard), собранная тем же кодом, что в агенте."""
    from app.memory.brief import build
    from app.memory.models import Fact, UserMemorySettings, iso

    now = datetime.now(UTC)

    def fact(category: str, text: str, slots: dict[str, str] | None = None) -> Fact:
        stamp = iso(now)
        return Fact(str(uuid.uuid4()), "u", category, text, slots, 4, 0.9, "active", "auto", "normal", None, text, 0, False,
                    stamp, stamp, None, None, None)

    facts = [
        fact("style", "", {"address": "Марина", "form": "ty", "advice": "ask_first"}),
        fact("person", "Сестра Аня: поддерживает", {"role": "сестра", "name": "Аня", "note": "поддерживает"}),
        fact("situation", "Ищет работу после увольнения в сентябре"),
        fact("works", "Помогают вечерние прогулки с собакой"),
        fact("boundary", "Не затрагивать тему отца"),
    ]
    return build(facts, UserMemorySettings("u", enabled=True), "standard", now)


async def main() -> int:
    with_memory = "--memory" in sys.argv
    memory = sample_brief() if with_memory else ""
    dialogs = {**DIALOGS, **(MEMORY_DIALOGS if with_memory else {})}
    if memory:
        print("Сводка памяти:\n" + memory)
    chat, stt = build_models(APP_CONFIG.llm)
    if chat is None:
        print("LLM_MODE=template: модели нет, проверять нечего. Нужен LLM_MODE=proxy.")
        return 1
    try:
        for title, turns in dialogs.items():
            print(f"\n=== {title} ===")
            history: list[Message] = []
            for n, text in enumerate(turns):
                history.append(Message(f"u{n}", "user", text, ""))
                if is_crisis(text):
                    reply = CRISIS_REPLY
                else:
                    reply = await chat.complete(chat_messages(history, APP_CONFIG.llm.history_messages, memory))
                history.append(Message(f"a{n}", "assistant", reply, ""))
                print(f"— {text}\n  {reply}")
    finally:
        await chat.aclose()
        if stt is not None:
            await stt.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
