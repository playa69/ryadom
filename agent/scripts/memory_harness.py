"""Харнесс памяти без UI (PROTEUS-242): реальные разговоры идут напрямую в функции агента, а не через приложение.

Что настоящее: хранилище диалогов (PostgreSQL), бэкенд памяти, извлекатель заметок на модели прокси, Cognee 1.5.3 (индекс прошлых
разговоров), блок памяти, который уходит в инструкцию модели, и ответ модели на вопрос с этим блоком. Ничего не мокается.
Печатает отчёт в Markdown: что извлечено после каждого разговора, что лежит в Cognee и что получает модель на вопросы.

Нужно: DIALOG_DATABASE_URL (пустая база; таблицы создаются), COGNEE_URL/COGNEE_EMAIL/COGNEE_PASSWORD, ключ прокси в
MEMORY_LLM_TOKEN_FILE (или AGENT_API_TOKEN). Запуск из agent/:

    uv run python scripts/memory_harness.py [--only "забудь"] [--out report.md] [--no-answers]

Все люди синтетические, после прогона их данные стираются (память, диалоги, датасет Cognee), если не задан --keep.
"""

import argparse
import asyncio
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AGENT_INTERNAL_TOKEN", "harness")

from app.clients.cognee import CogneeClient  # noqa: E402
from app.clients.llm import ProxyChat  # noqa: E402
from app.core.config import MemorySettings  # noqa: E402
from app.memory.cognee_backend import CogneeMemoryBackend  # noqa: E402
from app.memory.extractor import NotesExtractor  # noqa: E402
from app.memory.indexer import dataset_name  # noqa: E402
from app.services.dialog_db import DialogDatabase  # noqa: E402
from app.services.dialog_store import DialogStore  # noqa: E402
from app.services.replies import memory_block, system_prompt  # noqa: E402
from scripts.memory_harness_scenarios import SCENARIOS  # noqa: E402

CONSENT = "2026-10-21"


def token() -> str:
    path = os.environ.get("MEMORY_LLM_TOKEN_FILE")
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    value = os.environ.get("AGENT_API_TOKEN", "")
    if not value:
        raise SystemExit("нужен MEMORY_LLM_TOKEN_FILE или AGENT_API_TOKEN")
    return value


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def add(self, text: str = "") -> None:
        self.lines.append(text)
        print(text, flush=True)


def quote(text: str) -> str:
    return "\n".join("> " + line for line in text.splitlines()) if text.strip() else "> (пусто)"


async def settle(memory: CogneeMemoryBackend, rounds: int = 6) -> None:
    """Дождаться фоновых заданий: извлечение, очередь индекса (с повторами, пока она не опустеет)."""
    for _ in range(rounds):
        await memory.drain()
        while await memory.outbox.tick():
            pass
        await memory.drain()
        if await memory.outbox.pending() == 0:
            return
        await asyncio.sleep(2)


async def show_notes(memory: CogneeMemoryBackend, user: str, report: Report, title: str) -> None:
    notes = await memory.notes.list(user)
    report.add(f"**{title}** — заметок: {len(notes)}")
    for note in notes:
        mark = " (чувствительная)" if note["sensitive"] else ""
        when = f", {note['eventDate']}" if note["eventDate"] else ""
        report.add(f"- `{note['kind']}`{mark}{when}: {note['text']}")
    if not notes:
        report.add("- (нет)")
    report.add()


async def run_scenario(scn: dict, memory: CogneeMemoryBackend, store: DialogStore, client: CogneeClient, chat: ProxyChat, answers: bool, report: Report) -> str:
    user = str(uuid.uuid4())
    await store.ensure_user(user)
    await memory.update_settings(user, True, CONSENT)
    report.add(f"## Сценарий: {scn['name']}")
    report.add(f"_{scn['about']}_")
    report.add()
    for number, step in enumerate(scn["steps"], 1):
        if "toggle" in step:
            await memory.update_settings(user, None, None, sensitive_enabled=step["toggle"].get("sensitive"))
            report.add(f"### Шаг {number}: «Запоминать чувствительное» → {step['toggle'].get('sensitive')}")
        elif step.get("act"):
            report.add(f"### Шаг {number}: действие человека — «Удалить всю память»")
            await memory.forget_all(user)
            await settle(memory)
        else:
            report.add(f"### Шаг {number}: разговор")
        if step.get("say"):
            dialog, _, _ = store.start(user, new=True)
            for text in step["say"]:
                store.add_message(dialog, "user", text)
                store.add_message(dialog, "assistant", "Понимаю. Расскажи ещё, если хочешь.")  # реплики агента: контекст, не источник
                report.add(f"- человек: {text}")
            report.add()
            store.end(dialog, None, None)
            await store.flush()
            await settle(memory)
        await show_notes(memory, user, report, f"Заметки после шага {number}")
        found_any = False
        for probe in step.get("probes", []):
            found_any = True
            dialog, _, _ = store.start(user, new=True)
            found = await memory.recall_now(dialog, probe)
            block = memory.brief(dialog)
            report.add(f"#### Вопрос: «{probe}»")
            report.add("Что находит Cognee по вопросу (после фильтра подавленных реплик):")
            report.add(quote(found))
            report.add("Блок памяти, который получает модель:")
            report.add(quote(block))
            if answers:
                messages = [
                    {"role": "system", "content": system_prompt("male") + memory_block(block)},
                    {"role": "user", "content": probe},
                ]
                try:
                    reply = await chat.complete(messages)
                except Exception as error:  # noqa: BLE001
                    reply = f"(модель не ответила: {type(error).__name__})"
                report.add("Ответ модели:")
                report.add(quote(reply.strip()))
            report.add()
            store.end(dialog, None, None)
        if found_any:
            await store.flush()
    return user


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="часть названия сценария")
    parser.add_argument("--out", default="", help="файл отчёта")
    parser.add_argument("--no-answers", action="store_true", help="не звать модель ответа")
    parser.add_argument("--keep", action="store_true", help="не стирать данные после прогона")
    args = parser.parse_args()

    base = os.environ.get("LLM_BASE_URL", "https://shared1.multitool.works:4000/v1")
    model = os.environ.get("MEMORY_NOTES_MODEL", "gigachat3.5-432b-a28b")
    chat_model = os.environ.get("HARNESS_CHAT_MODEL", model)
    notes_chat = ProxyChat(base, token(), model, max_tokens=600, temperature=0.0, timeout_seconds=60)
    answer_chat = ProxyChat(base, token(), chat_model, max_tokens=400, temperature=0.3, timeout_seconds=60)

    db = DialogDatabase(os.environ["DIALOG_DATABASE_URL"])
    db.open()
    store = DialogStore()
    await store.attach(db, 0.2)
    client = CogneeClient(os.environ["COGNEE_URL"], os.environ.get("COGNEE_EMAIL", "spike@example.com"), os.environ.get("COGNEE_PASSWORD", "spike-password-123"))
    await client.connect()
    settings = MemorySettings(MEMORY_ALLOWLIST="", MEMORY_NOTES_ENABLED="true")
    memory = CogneeMemoryBackend(client, settings, lambda: store.database)
    store.memory = memory
    memory.set_extractor(NotesExtractor(notes_chat, memory.notes))
    import app.memory.cognee_backend as backend_module

    backend_module.INDEX_DELAY_SECONDS = 0  # документ в индекс сразу, а не через паузу «разговор успевает записаться»

    report = Report()
    report.add("# Харнесс памяти без UI")
    report.add(f"Модель извлечения: `{model}`; модель ответа: `{chat_model}`; Cognee: `{os.environ['COGNEE_URL']}`.")
    report.add()
    users: list[str] = []
    try:
        for scn in SCENARIOS:
            if args.only and args.only.lower() not in scn["name"].lower():
                continue
            users.append(await run_scenario(scn, memory, store, client, answer_chat, not args.no_answers, report))
    finally:
        if not args.keep:
            for user in users:
                try:
                    await memory.erase_user_data(user)
                    store.erase_user(user)
                    await store.erase_user_durable(user)
                    await client.forget_dataset(dataset_name(user))
                except Exception as error:  # noqa: BLE001
                    print(f"(не удалось стереть {user}: {type(error).__name__})")
        await store.flush()
        await client.aclose()
    if args.out:
        Path(args.out).write_text("\n".join(report.lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
