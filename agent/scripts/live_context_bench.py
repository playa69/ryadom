"""Замер оптимизации контекста Gemini Live (`GEMINI_TEXT_CONTEXT`): задержка ответа и токены на длинном диалоге.

    python scripts/live_context_bench.py --url http://127.0.0.1:8011 --token <AGENT_INTERNAL_TOKEN> \
        --pcm-dir <каталог с in_0_16k.pcm … in_4_16k.pcm> --turns 12 --label text_context=on --out result_on.json

Агент уже запущен в режиме gemini_live (скрипт его не запускает); запускать дважды: с `GEMINI_TEXT_CONTEXT=true` и `false`,
остальные настройки одинаковые. Скрипт ведёт один диалог из N голосовых реплик (пять готовых фраз по кругу), после каждого
ответа выдерживает паузу «человек думает» (в это время агент в фоне меняет сессию) и считывает `/metrics`:

  первый звук        от `audio_end` до `tts_start` ответа, как это слышит человек
  prompt_all         токены контекста хода (оплачиваются заново на каждый ход)
  prompt_audio/text  из них аудио и текст
  response_all       токены ответа

Берутся из `agent_gemini_tokens_total` (usage_metadata Gemini) приращением за ход.

Память (спецификация памяти, 16.5): `--memory-facts facts.jsonl` (строки `{"category", "text"}` или `{"category", "slots"}`)
включает память человеку прогона и записывает ему эти факты до разговора, так что в системную инструкцию уходит сводка
(агент запущен с `MEMORY_MODE=on` и нужным `MEMORY_BRIEF_LEVEL`). Два прогона, без и с `--memory-facts`, сравнивают входные
токены (ожидание: ≈ +500 на ход) и первый звук (медиана, p95; порог — не больше +50 мс p95).
"""

import argparse
import asyncio
import json
import re
import statistics
import sys
import time
import uuid
from pathlib import Path

import httpx

import live_smoke as ls  # тот же каталог: клиент протокола шлюза (Conn, send_voice, parse_answer)


async def counters(http: httpx.AsyncClient) -> dict[str, float]:
    text = (await http.get("/metrics")).text
    out: dict[str, float] = {}
    for m in re.finditer(r'^agent_gemini_tokens_total\{direction="(\w+)",modality="(\w+)"\} ([0-9.e+]+)', text, re.M):
        out[f"{m[1]}_{m[2]}"] = float(m[3])
    for m in re.finditer(r'^agent_gemini_context_refresh_total\{result="(\w+)"\} ([0-9.e+]+)', text, re.M):
        out[f"refresh_{m[1]}"] = float(m[2])
    return out


async def remember(http: httpx.AsyncClient, auth: dict[str, str], user: str, facts: Path) -> None:
    """Включить память человеку прогона и записать ему факты (как будто он написал их сам в разделе «Память»)."""
    settings = await http.put(f"/v1/users/{user}/memory/settings", json={"enabled": True, "consentVersion": "bench"}, headers=auth)
    settings.raise_for_status()
    for line in facts.read_text(encoding="utf-8").splitlines():
        if line.strip():
            response = await http.post(f"/v1/users/{user}/memory/facts", json=json.loads(line), headers=auth)
            print("факт:", response.status_code)
    print("память:", (await http.get("/health/ready")).json().get("memory"))


async def run(args) -> int:  # noqa: ANN001
    auth = {"Authorization": f"Bearer {args.token}"}
    ws_base = args.url.replace("http", "ws", 1)
    pcm_dir = Path(args.pcm_dir)
    phrases = [(pcm_dir / f"in_{i}_16k.pcm").read_bytes() for i in range(5)]
    rows: list[dict] = []
    async with httpx.AsyncClient(base_url=args.url, timeout=20) as http:
        print("готовность:", (await http.get("/health/ready")).json())
        user = str(uuid.uuid4())
        if args.memory_facts:
            await remember(http, auth, user, Path(args.memory_facts))
        dialog = (await http.post(f"/v1/users/{user}/dialogs", headers=auth)).json()["dialogId"]
        conn = await ls.open_socket(ws_base, auth, user, dialog)
        await conn.wait(0, lambda sl: ls.has(sl, "tts_end", messageId="greeting"), 20)  # приветствие
        for n in range(1, args.turns + 1):
            before = await counters(http)
            since = conn.mark()
            sent = await ls.send_voice(conn, phrases[(n - 1) % len(phrases)], args.pace)
            sl = await conn.wait(since, ls.answered, 45)
            row: dict = {"turn": n}
            if sl is None:
                row["error"] = "ответ не дошёл за 45 с"
                rows.append(row)
                print(row)
                continue
            ans = ls.parse_answer(sl)
            row["first_sound_s"] = round(ans.tts_start.t - sent, 2) if ans.tts_start else None
            row["reply_s"] = round(ans.seconds, 1)
            # пауза «человек думает»: в это время приходит usage и агент меняет сессию
            deadline = time.monotonic() + args.think
            after = before
            while time.monotonic() < deadline or after.get("prompt_all", 0) == before.get("prompt_all", 0):
                await asyncio.sleep(0.5)
                after = await counters(http)
                if time.monotonic() > deadline + 8:
                    break
            for key in ("prompt_all", "prompt_audio", "prompt_text", "response_all", "response_audio"):
                row[key] = int(after.get(key, 0) - before.get(key, 0))
            row["refresh_ok"] = int(after.get("refresh_ok", 0) - before.get("refresh_ok", 0))
            rows.append(row)
            print(row, flush=True)
        await conn.send({"type": "end"})
        await conn.close()

    ok = [r for r in rows if "error" not in r and r.get("first_sound_s") is not None]
    summary = {
        "label": args.label,
        "turns": len(rows),
        "answered": len(ok),
        "first_sound_median_s": round(statistics.median(r["first_sound_s"] for r in ok), 2) if ok else None,
        "first_sound_mean_s": round(statistics.fmean(r["first_sound_s"] for r in ok), 2) if ok else None,
        "first_sound_max_s": max((r["first_sound_s"] for r in ok), default=None),
        "first_sound_p95_s": round(statistics.quantiles([r["first_sound_s"] for r in ok], n=20)[-1], 2) if len(ok) >= 2 else None,
        "memory": bool(args.memory_facts),
        "prompt_tokens_total": sum(r["prompt_all"] for r in ok),
        "prompt_audio_total": sum(r["prompt_audio"] for r in ok),
        "prompt_text_total": sum(r["prompt_text"] for r in ok),
        "response_tokens_total": sum(r["response_all"] for r in ok),
        "last_turn_prompt_tokens": ok[-1]["prompt_all"] if ok else None,
    }
    print("\nИТОГ", json.dumps(summary, ensure_ascii=False))
    if args.out:
        Path(args.out).write_text(json.dumps({"summary": summary, "turns": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if len(ok) == len(rows) else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # консоль Windows по умолчанию не знает кириллицы
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8011")
    parser.add_argument("--token")
    parser.add_argument("--pcm-dir", required=True)
    parser.add_argument("--turns", type=int, default=12)
    parser.add_argument("--pace", type=float, default=0.02, help="пауза между кадрами голоса, с (0,1 — реальное время)")
    parser.add_argument("--think", type=float, default=3.0, help="пауза «человек думает» после ответа, с")
    parser.add_argument("--label", default="")
    parser.add_argument("--memory-facts", help="факты памяти (jsonl): прогон со сводкой в системной инструкции")
    parser.add_argument("--out")
    args = parser.parse_args()
    if not args.token:
        sys.exit("нужен --token")
    sys.exit(asyncio.run(run(args)))
