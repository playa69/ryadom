"""Прогон золотого набора заметок на настоящей модели (PROTEUS-242, задача 7.2).

Нужно: AGENT_API_TOKEN (ключ прокси программы) в окружении или в файле MEMORY_LLM_TOKEN_FILE; LLM_BASE_URL и MEMORY_NOTES_MODEL необязательны.
Запуск: `uv run python scripts/memory_golden.py`. Печатает точность, полноту, утечки запретного и задержку; ключ не печатает.
Порог из спеки: точность ≥ 0,9, полнота ≥ 0,75, утечек 0.
"""

import asyncio
import os
import statistics
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.clients.background_model import ProxyBackgroundModel  # noqa: E402
from app.memory.extractor import NotesExtractor  # noqa: E402
from app.memory.notes import NotesService  # noqa: E402
from scripts.memory_golden_data import CASES  # noqa: E402
from tests.fake_db import FakeDialogDatabase  # noqa: E402


def token() -> str:
    path = os.environ.get("MEMORY_LLM_TOKEN_FILE")
    if path:
        return Path(path).read_text(encoding="utf-8").strip()
    value = os.environ.get("AGENT_API_TOKEN", "")
    if not value:
        raise SystemExit("нужен AGENT_API_TOKEN или MEMORY_LLM_TOKEN_FILE")
    return value


async def run() -> int:
    base = os.environ.get("LLM_BASE_URL", "https://shared1.multitool.works:4000/v1")
    model = os.environ.get("MEMORY_NOTES_MODEL", "gigachat3.5-432b-a28b")
    chat = ProxyBackgroundModel(base, token(), model, max_tokens=600, temperature=0.0, timeout_seconds=60)
    FakeDialogDatabase.reset()
    db = FakeDialogDatabase("golden")
    db.open()
    notes = NotesService(lambda: db, 200)
    extractor = NotesExtractor(chat, notes)  # type: ignore[arg-type]

    expected = found = produced = correct = leaks = 0
    latencies: list[float] = []
    failures: list[str] = []
    for index, case in enumerate(CASES):
        user = str(uuid.uuid4())
        for kind, text in case.get("notes", []):
            await notes.add(user, kind, text)
        started = time.perf_counter()
        outcome = await extractor.extract(user, case["say"], [])
        latencies.append(time.perf_counter() - started)
        texts = [n["text"].lower() for n in outcome.added + outcome.updated]
        for kind, keyword in case.get("expect", []):
            expected += 1
            if any(keyword in text for text in texts):
                found += 1
            else:
                failures.append(f"#{index} не найдена заметка «{keyword}»")
        produced += len(outcome.added)
        # добавленная заметка верна, если ждали её слово (иначе лишняя)
        wanted = [kw for _, kw in case.get("expect", [])]
        right = [n for n in outcome.added if any(kw in n["text"].lower() for kw in wanted)]
        correct += len(right)
        for extra in [n for n in outcome.added if n not in right]:
            failures.append(f"#{index} лишняя заметка: «{extra['text']}» (реплика: «{case['say'][0][:50]}»)")
        for word in case.get("forbid", []):
            if any(word in text for text in texts):
                leaks += 1
                failures.append(f"#{index} утечка запретного (слово из forbid)")
        left = [n["text"].lower() for n in await notes.list(user)]
        if case.get("want_delete") and any(case["want_delete"] in text for text in left):
            failures.append(f"#{index} просили убрать «{case['want_delete']}», заметка осталась")
        if case.get("want_update") and not any(case["want_update"] in text for text in left):
            failures.append(f"#{index} просили поправить «{case['want_update']}», правки нет")
        if case.get("keep") and not any(case["keep"] in text for text in left):
            failures.append(f"#{index} заметка «{case['keep']}» удалена без явной просьбы")
    await chat.aclose()
    precision = correct / produced if produced else 1.0
    recall = found / expected if expected else 1.0
    p95 = statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 20 else max(latencies)
    print(f"модель={model} случаев={len(CASES)}")
    print(f"точность={precision:.2f} (порог 0.90)  полнота={recall:.2f} (порог 0.75)  утечек={leaks} (порог 0)  p95={p95:.1f}с")
    for line in failures:
        print("  -", line)
    ok = precision >= 0.9 and recall >= 0.75 and leaks == 0
    print("ИТОГ:", "порог пройден" if ok else "порог НЕ пройден")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
