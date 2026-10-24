"""Клиент локальных экспериментов с памятью агента (ветка feature/memory_samofalov).

Говорит с агентом на http://127.0.0.1:8001 (его поднимает scripts/local_memory_serve.py).
Токен читает из agent/.env, значение не печатается. Запуск из каталога agent/:

    .venv/bin/python scripts/memory_local.py setup     # включить память (согласие)
    .venv/bin/python scripts/memory_local.py talk      # сценарный диалог с фактами о себе
    .venv/bin/python scripts/memory_local.py facts     # что агент извлёк и хранит
    .venv/bin/python scripts/memory_local.py ask "Что ты обо мне помнишь?"   # новый диалог: сводка в деле
    .venv/bin/python scripts/memory_local.py erase     # «забыть всё»
"""

import asyncio
import json
import sys
import uuid
from pathlib import Path

import httpx
import websockets
from dotenv import dotenv_values

BASE = "http://127.0.0.1:8001"
USER_ID = "00000000-0000-4000-8000-000000000042"
CONSENT_VERSION = "2026-10-12"

SCENARIO = [
    "Привет! Меня зовут Александр. Не люблю, когда меня называют Саней — называй меня Александр.",
    "У меня жена Аня и сын Матвей, ему шесть лет.",
    "Я работаю программистом, часто сижу допоздна и из-за этого плохо сплю.",
    "Когда мне тревожно, помогает разобрать ситуацию по шагам, а не просто услышать «всё будет хорошо».",
    "Ещё я бегаю по утрам в парке — это единственное, что реально clears my head.",
]


def token() -> str:
    value = dotenv_values(Path(__file__).resolve().parent.parent / ".env").get("AGENT_INTERNAL_TOKEN")
    if not value:
        sys.exit("В agent/.env нет AGENT_INTERNAL_TOKEN")
    return value


def headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {token()}"}


async def receive_turn(ws) -> str:
    """Дочитать реплику ассистента до assistant_end, вернуть текст."""
    parts: list[str] = []
    while True:
        raw = await ws.recv()
        if isinstance(raw, bytes):
            continue  # аудио-кадры TTS (в cognee-режиме озвучка qwen включена)
        frame = json.loads(raw)
        kind = frame.get("type")
        if kind == "assistant_delta":
            parts.append(frame.get("text", ""))
        elif kind == "assistant_end":
            return frame.get("text", "".join(parts))
        elif kind in ("ended", "error", "safety"):
            print(f"  [{kind}] {frame.get('text') or frame.get('code') or ''}")
            if kind == "ended":
                return "".join(parts)


async def run_dialog(lines: list[str], end: bool = True) -> None:
    async with httpx.AsyncClient(base_url=BASE, headers=headers(), timeout=30) as client:
        resp = await client.post(f"/v1/users/{USER_ID}/dialogs", json={"new": True})
        resp.raise_for_status()
        info = resp.json()
        print(f"диалог {info['dialogId']} memoryMode={info['memoryMode']} memoryEnabled={info['memoryEnabled']}")
        dialog_id = info["dialogId"]
    url = f"ws://127.0.0.1:8001/v1/users/{USER_ID}/dialogs/{dialog_id}/ws"
    async with websockets.connect(url, additional_headers=headers()) as ws:
        assert json.loads(await ws.recv())["type"] == "ready"
        if info.get("greeting"):
            print(f"агент: {await receive_turn(ws)}")
        for i, line in enumerate(lines):
            print(f"ты:    {line}")
            await ws.send(json.dumps({"type": "user_message", "id": f"c-{i}", "text": line}))
            print(f"агент: {await receive_turn(ws)}\n")
        if end:
            await ws.send(json.dumps({"type": "end", "takeaway": "Поговорили", "tensionAfter": 3}))
            while True:
                raw = await ws.recv()
                if isinstance(raw, bytes):
                    continue  # аудио-кадры TTS
                frame = json.loads(raw)
                if frame.get("type") == "ended":
                    break
            print("диалог завершён, задание на извлечение поставлено")


async def wait_extraction() -> None:
    print("жду воркер извлечения (опрос раз в 5 с)…")
    async with httpx.AsyncClient(base_url=BASE, headers=headers(), timeout=30) as client:
        for _ in range(12):
            await asyncio.sleep(5)
            changes = (await client.get(f"/v1/users/{USER_ID}/memory/changes")).json()
            if changes.get("changes"):
                print("извлечение отработало")
                return
    print("воркер молчит — смотри лог сервера")


async def show_facts() -> None:
    async with httpx.AsyncClient(base_url=BASE, headers=headers(), timeout=30) as client:
        data = (await client.get(f"/v1/users/{USER_ID}/memory")).json()
    settings = data.get("settings", {})
    print(f"память: enabled={settings.get('enabled')} mode={data.get('mode')}")
    facts = data.get("facts", [])
    if not facts:
        print("фактов нет")
    for fact in facts:
        print(f"  [{fact['category']}] {fact.get('text') or fact.get('slots')} "
              f"(status={fact['status']}, importance={fact.get('importance')})")


async def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "setup":
        async with httpx.AsyncClient(base_url=BASE, headers=headers(), timeout=30) as client:
            resp = await client.put(
                f"/v1/users/{USER_ID}/memory/settings",
                json={"enabled": True, "consentVersion": CONSENT_VERSION},
            )
            resp.raise_for_status()
        print("память включена, согласие", CONSENT_VERSION)
    elif command == "talk":
        await run_dialog(SCENARIO)
        await wait_extraction()
        await show_facts()
    elif command == "ask":
        question = sys.argv[2] if len(sys.argv) > 2 else "Привет! Что ты обо мне помнишь?"
        await run_dialog([question], end=False)
    elif command == "facts":
        await show_facts()
    elif command == "erase":
        async with httpx.AsyncClient(base_url=BASE, headers=headers(), timeout=30) as client:
            (await client.delete(f"/v1/users/{USER_ID}/memory")).raise_for_status()
        print("память стёрта")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    asyncio.run(main())
