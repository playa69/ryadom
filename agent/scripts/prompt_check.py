"""Ручная проверка системного промпта на живой чат-модели: прогоняет набор диалогов и печатает ответы.

    uv run python scripts/prompt_check.py

Нужны те же настройки, что у сервиса в режиме `LLM_MODE=proxy` (`.env` или переменные окружения): ключ прокси и адрес.
Ответы строятся так же, как в диалоге: `chat_messages` по истории, кризис — фиксированным текстом без модели.
Скрипт ничего не проверяет автоматически: тон и длину ответов оценивает человек.
"""

import asyncio
import sys

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
}


async def main() -> int:
    chat, stt = build_models(APP_CONFIG.llm)
    if chat is None:
        print("LLM_MODE=template: модели нет, проверять нечего. Нужен LLM_MODE=proxy.")
        return 1
    try:
        for title, turns in DIALOGS.items():
            print(f"\n=== {title} ===")
            history: list[Message] = []
            for n, text in enumerate(turns):
                history.append(Message(f"u{n}", "user", text, ""))
                if is_crisis(text):
                    reply = CRISIS_REPLY
                else:
                    reply = await chat.complete(chat_messages(history, APP_CONFIG.llm.history_messages))
                history.append(Message(f"a{n}", "assistant", reply, ""))
                print(f"— {text}\n  {reply}")
    finally:
        await chat.aclose()
        if stt is not None:
            await stt.aclose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
