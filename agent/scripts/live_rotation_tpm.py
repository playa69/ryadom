"""Замер: как Google считает в лимите входных токенов в минуту (TPM) ход внутри долгой сессии Gemini Live.

    python scripts/live_rotation_tpm.py --arm rotate1 --dialogs 8 --turns 8 --pcm-dir <каталог с in_0_16k.pcm … in_4_16k.pcm> \
        --out rotate1.json

Ключ берётся из окружения (`GEMINI_API_KEY`), агент не нужен: скрипт ходит в Gemini Live тем же `GeminiLiveConnector`, с теми же
инструкциями и настройками сессии, что и агент. Каждый из `--dialogs` диалогов ведёт `--turns` голосовых реплик (пять готовых фраз
по кругу, `activity_start/end` вручную, как в агенте). Варианты (`--arm`):

  rotate1  после каждого ответа сессия меняется на свежую с текстовой историей (как агент сейчас, GEMINI_TEXT_CONTEXT)
  rotate4  то же раз в четыре ответа
  long     одна сессия на весь диалог, без смены (аудио копится в контексте)

Печатает и пишет в JSON времена (UTC), токены каждого хода из usage_metadata (input — весь контекст хода) и число открытий:
по ним и по графику AI Studio «Peak input tokens per minute» видно, считает Google ход целиком (как оплату) или приращением.
Тексты реплик не сохраняются, ключ не печатается.
"""

import argparse
import asyncio
import json
import random
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api.dialog_live import LIVE_ADDENDUM  # noqa: E402
from app.clients.gemini_live import GeminiLiveConnector, input_tokens  # noqa: E402
from app.core.config import APP_CONFIG  # noqa: E402
from app.services.replies import SYSTEM_PROMPT  # noqa: E402

ARMS = {"rotate1": 1, "rotate4": 4, "long": 0}
FRAME = 3200  # 100 мс PCM16 16 кГц
TURN_TIMEOUT = 60.0


def stamp() -> str:
    return datetime.now(UTC).strftime("%H:%M:%S")


async def pump(link, queue: asyncio.Queue) -> None:  # noqa: ANN001
    async for event in link.events():
        queue.put_nowait(event)


class Dialog:
    def __init__(self, index: int, connector: GeminiLiveConnector, instructions: str, phrases: list[bytes], args) -> None:  # noqa: ANN001
        self.index = index
        self.connector = connector
        self.instructions = instructions
        self.phrases = phrases
        self.args = args
        self.every = ARMS[args.arm]
        self.history: list[tuple[str, str]] = []
        self.link = None
        self.queue: asyncio.Queue = asyncio.Queue()
        self.reader: asyncio.Task | None = None
        self.since = 0
        self.rows: list[dict] = []
        self.opens: list[dict] = []
        self.error: str | None = None

    async def open(self, purpose: str) -> None:
        started = time.time()
        history = self.history or None
        self.link = await self.connector.open("male", self.instructions, None, history)
        self.queue = asyncio.Queue()
        self.reader = asyncio.create_task(pump(self.link, self.queue))
        self.since = 0
        self.opens.append({"at": started, "seconds": round(time.time() - started, 2), "history": len(self.history), "purpose": purpose})

    async def close(self) -> None:
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        if self.link is not None:
            await self.link.aclose()
        self.link = self.reader = None

    async def turn(self, number: int) -> None:
        pcm = self.phrases[number % len(self.phrases)]
        started = time.time()
        await self.link.activity_start()
        for at in range(0, len(pcm), FRAME):
            await self.link.send_audio(pcm[at : at + FRAME].ljust(FRAME, b"\x00"))
        await self.link.activity_end()
        sent = time.time()
        said, heard, usage, complete = [], [], None, False
        async with asyncio.timeout(TURN_TIMEOUT):
            while not (complete and usage is not None):
                event = await self.queue.get()
                if event.kind == "input_text":
                    said.append(event.text)
                elif event.kind == "output_text":
                    heard.append(event.text)
                elif event.kind == "usage":
                    usage = event.usage
                elif event.kind == "turn_complete":
                    complete = True
                elif event.kind == "closed":
                    raise RuntimeError(f"сессия закрыта: {event.text}")
        self.history += [("user", "".join(said).strip() or "(реплика)"), ("model", "".join(heard).strip() or "(ответ)")]
        self.since += 1
        self.rows.append(
            {
                "turn": number + 1,
                "at": started,
                "answered_seconds": round(time.time() - sent, 2),
                "input": input_tokens(usage),
                "usage": usage,
                "session_turn": self.since,
            }
        )

    async def run(self) -> None:
        await asyncio.sleep(random.uniform(0, self.args.stagger))
        try:
            await self.open("start")
            for number in range(self.args.turns):
                await self.turn(number)
                if self.every and self.since >= self.every:
                    # Как агент в обычном режиме: сразу после ответа, пока человек «думает».
                    await self.close()
                    await self.open("rotate")
                await asyncio.sleep(self.args.pause)
        except Exception as error:  # noqa: BLE001
            self.error = f"{type(error).__name__}: {str(error)[:200]}"
            print(f"[{stamp()}] dialog {self.index} failed: {self.error}", flush=True)
        finally:
            await self.close()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", choices=sorted(ARMS), required=True)
    parser.add_argument("--dialogs", type=int, default=8)
    parser.add_argument("--turns", type=int, default=8)
    parser.add_argument("--pause", type=float, default=2.0, help="пауза «человек думает» после ответа, с")
    parser.add_argument("--stagger", type=float, default=4.0, help="разброс старта диалогов, с")
    parser.add_argument("--pcm-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    phrases = [(args.pcm_dir / f"in_{n}_16k.pcm").read_bytes() for n in range(5)]
    connector = GeminiLiveConnector(APP_CONFIG.gemini)
    instructions = SYSTEM_PROMPT + LIVE_ADDENDUM
    started = time.time()
    print(f"[{stamp()}] UTC start arm={args.arm} dialogs={args.dialogs} turns={args.turns}", flush=True)
    dialogs = [Dialog(n, connector, instructions, phrases, args) for n in range(args.dialogs)]
    await asyncio.gather(*(d.run() for d in dialogs))
    finished = time.time()

    turns = [row for d in dialogs for row in d.rows]
    opens = [o for d in dialogs for o in d.opens]
    summary = {
        "arm": args.arm,
        "dialogs": args.dialogs,
        "turns_planned": args.dialogs * args.turns,
        "turns_done": len(turns),
        "opens": len(opens),
        "failed_dialogs": sum(1 for d in dialogs if d.error),
        "turns_without_audio_reply": sum(1 for row in turns if not row["usage"].get("output_audio")),
        "sum_input": sum(row["input"] for row in turns),
        "sum_input_by_session_turn": {
            k: sum(r["input"] for r in turns if r["session_turn"] == k) for k in sorted({r["session_turn"] for r in turns})
        },
        "started_utc": datetime.fromtimestamp(started, UTC).isoformat(timespec="seconds"),
        "finished_utc": datetime.fromtimestamp(finished, UTC).isoformat(timespec="seconds"),
        "seconds": round(finished - started, 1),
    }
    args.out.write_text(
        json.dumps({"summary": summary, "dialogs": [{"rows": d.rows, "opens": d.opens, "error": d.error} for d in dialogs]}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False), flush=True)


asyncio.run(main())
