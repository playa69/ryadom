"""Замер прототипа PROTEUS-168: сколько добавляет `report_mood` к задержке ответа Gemini Live.

    # агент 1: GEMINI_MOOD_TOOL=0, агент 2: GEMINI_MOOD_TOOL=1 (оба gemini_live), затем:
    python scripts/mood_latency.py --url http://127.0.0.1:8011 --token <AGENT_INTERNAL_TOKEN> \
        --pcm-dir <каталог с in_0_16k.pcm …> --runs 10 --label tool_off
    python scripts/mood_latency.py --url http://127.0.0.1:8012 ... --label tool_on

На каждый прогон — новый разговор и одна голосовая реплика (как в live_smoke.py: audio_start, кадры, audio_end). Мерим от
отправки audio_end: до первого кадра `mood` (если есть), до `assistant_start` и до первого кадра голоса (0x02). Печатает
медиану и p90 по каждому показателю и JSON-строку для сравнения двух запусков. Ключ Gemini скрипту не нужен (он у агента).
"""

import argparse
import asyncio
import json
import os
import statistics
import struct
import time
import uuid
from pathlib import Path

import httpx
from websockets.asyncio.client import connect

IN_FRAME = 3200  # 100 мс PCM16 16 кГц
ANSWER_TIMEOUT = 12.0
MOOD_GRACE = 4.0  # сколько ждать mood после первого звука ответа


async def one_run(http: httpx.AsyncClient, ws_base: str, auth: dict, pcm: bytes, pace: float) -> dict[str, float | None]:
    user = str(uuid.uuid4())
    started = await http.post(f"/v1/users/{user}/dialogs", headers=auth)
    started.raise_for_status()
    dialog = started.json()["dialogId"]
    marks: dict[str, float] = {}
    tones: dict[str, str] = {}
    async with connect(f"{ws_base}/v1/users/{user}/dialogs/{dialog}/ws", additional_headers=auth, max_size=None) as ws:
        async for message in ws:  # приветствие проходит до своего tts_end, потом наш ход
            if not isinstance(message, bytes) and json.loads(message).get("type") == "tts_end":
                break
        await ws.send(json.dumps({"type": "audio_start"}))
        for n, at in enumerate(range(0, len(pcm), IN_FRAME)):
            chunk = pcm[at : at + IN_FRAME].ljust(IN_FRAME, b"\x00")
            await ws.send(struct.pack(">BI", 0x01, n) + chunk)
            await asyncio.sleep(pace)
        await ws.send(json.dumps({"type": "audio_end"}))
        sent = time.monotonic()

        async def listen() -> None:
            async for message in ws:
                now = time.monotonic() - sent
                if isinstance(message, bytes):
                    if message[:1] == b"\x02":
                        marks.setdefault("first_audio", now)
                    if "first_audio" in marks and ("mood" in marks or now - marks["first_audio"] > MOOD_GRACE):
                        return
                    continue
                frame = json.loads(message)
                kind = frame.get("type")
                if kind == "transcript" and frame.get("final"):
                    marks.setdefault("transcript", now)
                if kind in ("mood", "assistant_start"):
                    marks.setdefault(kind, now)
                if kind == "mood":
                    tones.setdefault("tone", frame["tone"])
                if "first_audio" in marks and "mood" in marks:
                    return

        try:
            await asyncio.wait_for(listen(), ANSWER_TIMEOUT)
        except TimeoutError:
            pass
    print(f"    tone={tones.get('tone', '—')}")
    return {name: marks.get(name) for name in ("transcript", "mood", "assistant_start", "first_audio")}


def summary(values: list[float | None]) -> dict[str, float | int | None]:
    got = sorted(v for v in values if v is not None)
    if not got:
        return {"n": 0, "median": None, "p90": None}
    return {"n": len(got), "median": round(statistics.median(got), 3), "p90": round(got[int(0.9 * (len(got) - 1))], 3)}


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8011")
    parser.add_argument("--token", default=os.environ.get("AGENT_INTERNAL_TOKEN"))
    parser.add_argument("--pcm-dir", required=True)
    parser.add_argument("--pcm", default="in_0_16k.pcm")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--pace", type=float, default=0.1, help="пауза между кадрами, с (0,1 — реальное время)")
    parser.add_argument("--label", default="run")
    args = parser.parse_args()
    auth = {"Authorization": f"Bearer {args.token}"}
    pcm = (Path(args.pcm_dir) / args.pcm).read_bytes()
    ws_base = args.url.replace("http", "ws", 1)
    runs: list[dict[str, float | None]] = []
    async with httpx.AsyncClient(base_url=args.url, timeout=30) as http:
        for i in range(args.runs):
            runs.append(await one_run(http, ws_base, auth, pcm, args.pace))
            print(f"  {i + 1}/{args.runs}: " + " ".join(f"{k}={v:.2f}" if v is not None else f"{k}=—" for k, v in runs[-1].items()))
    report = {name: summary([r[name] for r in runs]) for name in ("transcript", "mood", "assistant_start", "first_audio")}
    print(json.dumps({"label": args.label, "runs": args.runs, "from_audio_end_seconds": report}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
