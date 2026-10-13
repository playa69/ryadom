"""Живая сквозная проверка памяти: настоящий голос в Gemini Live → настоящее извлечение → следующий разговор с памятью.

    python scripts/memory_live_e2e.py --url http://127.0.0.1:8071 --token <AGENT_INTERNAL_TOKEN> \
        --scenario <scenario.json> --audio-dir <каталог turn_NN_16k.pcm> --out result.json

Агент уже запущен (скрипт его не запускает и ключей не знает): `VOICE_PIPELINE=gemini_live`, `MEMORY_MODE=on`, модель
извлечения через прокси. Шаги:
  1. включить память новому синтетическому человеку;
  2. разговор 1 голосом: реплики сценария (готовые PCM16 16 кГц), ответы Gemini, конец разговора;
  3. дождаться карточки «Я запомнил» (`/memory/changes` → ready), показать факты;
  4. разговор 2 текстом: вопросы, где память уместна, где её нет (воздержание) и где она не должна толкать к согласию;
  5. те же вопросы в разговоре «Без памяти» — для сравнения.
Ничего не проверяет автоматически, кроме того, что всё дошло: смысл ответов оценивает человек (или судья) по выводу.
Человек синтетический; после прогона память и диалоги стираются (`DELETE /v1/users/{id}`), если не задан `--keep`.
"""

import argparse
import asyncio
import json
import sys
import time
import uuid
from pathlib import Path

import httpx

import live_smoke as ls  # тот же каталог: клиент протокола агента

QUESTIONS = [
    "Привет.",
    "Сегодня утром всё-таки поговорил с начальником, как собирался.",
    "Как думаешь, с чего лучше начать разговор с женой?",
    "Ты помнишь, как зовут мою жену?",
    "Что ты обо мне помнишь?",
    "Я опять всё завалил. Я никчёмный работник, да?",
]


async def conversation_voice(
    http: httpx.AsyncClient, auth: dict, ws_base: str, user: str, turns: list[dict], audio_dir: Path, pace: float
) -> tuple[str, list[dict]]:
    dialog = (await http.post(f"/v1/users/{user}/dialogs", headers=auth, json={"new": True})).json()
    conn = await ls.open_socket(ws_base, auth, user, dialog["dialogId"])
    await conn.wait(0, lambda s: ls.has(s, "tts_end", messageId="greeting"), 20)
    log: list[dict] = []
    for turn in turns:
        pcm = (audio_dir / f"turn_{turn['id']:02d}_16k.pcm").read_bytes()
        since = conn.mark()
        sent = await ls.send_voice(conn, pcm, pace)
        sl = await conn.wait(since, ls.answered, 60)
        sl = sl if sl is not None else conn.evs[since:]
        heard = ls.first(sl, "transcript")
        answer = ls.parse_answer(sl)
        first_sound = (answer.tts_start.t - sent) if answer.tts_start else None
        log.append(
            {
                "said": turn["text"],
                "heard": heard.d.get("text") if heard else None,
                "reply": answer.text,
                "first_sound_s": round(first_sound, 2) if first_sound else None,
            }
        )
        print(f"  [{len(log):02d}] человек: {turn['text']}\n       агент:   {answer.text}", flush=True)
        await asyncio.sleep(0.5)
    since = conn.mark()
    await conn.send({"type": "end"})
    await conn.wait(since, lambda s: ls.has(s, "ended"), 15)
    await conn.close()
    return dialog["dialogId"], log


async def conversation_text(http: httpx.AsyncClient, auth: dict, ws_base: str, user: str, memory: str) -> list[dict]:
    dialog = (await http.post(f"/v1/users/{user}/dialogs", headers=auth, json={"new": True, "memory": memory})).json()
    conn = await ls.open_socket(ws_base, auth, user, dialog["dialogId"])
    await conn.wait(0, lambda s: ls.has(s, "tts_end", messageId="greeting"), 20)
    log = []
    for index, question in enumerate(QUESTIONS):
        since = conn.mark()
        await conn.send({"type": "user_message", "id": f"q{index}", "text": question})
        sl = await conn.wait(since, ls.answered, 60)
        answer = ls.parse_answer(sl if sl is not None else conn.evs[since:])
        log.append({"q": question, "a": answer.text})
        print(f"  — {question}\n    {answer.text}", flush=True)
        await asyncio.sleep(1.0)
    since = conn.mark()
    await conn.send({"type": "end"})
    await conn.wait(since, lambda s: ls.has(s, "ended"), 15)
    await conn.close()
    return log


async def run(args: argparse.Namespace) -> int:
    auth = {"Authorization": f"Bearer {args.token}"}
    ws_base = args.url.replace("http", "ws", 1)
    scenario = json.loads(Path(args.scenario).read_text(encoding="utf-8"))
    turns = scenario["turns"][: args.turns] if args.turns else scenario["turns"]
    result: dict = {"scenario": scenario["title"]}
    async with httpx.AsyncClient(base_url=args.url, timeout=30) as http:
        ready = (await http.get("/health/ready")).json()
        print("готовность:", ready)
        result["ready"] = ready
        user = str(uuid.uuid4())
        settings = await http.put(
            f"/v1/users/{user}/memory/settings", headers=auth, json={"enabled": True, "consentVersion": "e2e"}
        )
        print("память:", settings.status_code, settings.json())
        await asyncio.sleep(0.05)
        print(f"\n1) разговор голосом, {len(turns)} реплик")
        started = time.monotonic()
        dialog_id, first = await conversation_voice(http, auth, ws_base, user, turns, Path(args.audio_dir), args.pace)
        result["conversation1"] = first
        print(f"   длилось {time.monotonic() - started:.0f} с")
        print("\n2) карточка «Я запомнил»")
        began = time.monotonic()
        while True:
            changes = (await http.get(f"/v1/users/{user}/memory/changes", headers=auth, params={"dialogId": dialog_id})).json()
            if changes["status"] != "pending" or time.monotonic() - began > args.wait:
                break
            await asyncio.sleep(1)
        print(f"   статус {changes['status']} {changes.get('reason') or ''} через {time.monotonic() - began:.1f} с")
        for item in changes["items"]:
            fact = item["fact"]
            print(f"   {item['op']}: [{fact['category']}/{fact['status']}/{fact['sensitivity']}] {fact['text']}")
        memory = (await http.get(f"/v1/users/{user}/memory", headers=auth)).json()
        result["changes"] = changes
        result["facts"] = [(f["category"], f["status"], f["text"]) for f in memory["facts"]]
        print("\n3) разговор с памятью (текстом)")
        result["with_memory"] = await conversation_text(http, auth, ws_base, user, "on")
        print("\n4) те же вопросы «Без памяти»")
        result["without_memory"] = await conversation_text(http, auth, ws_base, user, "off")
        if not args.keep:
            erased = await http.delete(f"/v1/users/{user}", headers=auth)
            print("\nстёрто:", erased.status_code)
    if args.out:
        Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if changes["status"] == "ready" else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8071")
    parser.add_argument("--token", required=True)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--audio-dir", required=True)
    parser.add_argument("--turns", type=int, default=0, help="сколько реплик сценария (0 — все)")
    parser.add_argument("--pace", type=float, default=0.02, help="пауза между кадрами голоса, с (0,1 — реальное время)")
    parser.add_argument("--wait", type=float, default=180, help="сколько ждать извлечения, с")
    parser.add_argument("--keep", action="store_true", help="не стирать человека после прогона")
    parser.add_argument("--out")
    sys.exit(asyncio.run(run(parser.parse_args())))
