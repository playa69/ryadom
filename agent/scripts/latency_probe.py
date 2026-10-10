"""Замер задержек моделей через прокси: где уходит время и отдаёт ли прокси звук и текст потоком.

    AGENT_API_TOKEN=<ключ прокси> uv run python scripts/latency_probe.py --base-url https://shared1.multitool.works:4000/v1

Для чата: время до первого токена и до конца, со стримом и без. Для озвучки Qwen: время до первого байта и до
конца ответа, плюс как приходят куски. Если первый байт приходит почти вместе с последним (прокси собирает
ответ целиком), потоковый вывод звука ничего не даст; если первый байт заметно раньше, его стоит читать потоком.

Ключ берётся только из окружения, в вывод не попадает. Тексты фиксированные и ничьих данных не содержат.
"""

import argparse
import asyncio
import json
import os
import statistics
import sys
import time

import httpx

CHAT_PROMPT = [
    {"role": "system", "content": "Ты тёплый собеседник. Отвечай по-русски, одним-тремя короткими предложениями."},
    {"role": "user", "content": "Мне сегодня тревожно, на работе всё валится."},
]
PHRASES = (
    "Я слышу тебя.",
    "Я слышу тебя. Расскажи, что у тебя на душе?",
    "Звучит так, будто на работе сейчас много всего навалилось. Что из этого давит сильнее всего?",
)


def median(values: list[float]) -> str:
    return f"{statistics.median(values):.2f}" if values else "—"


async def probe_chat(client: httpx.AsyncClient, base: str, headers: dict, model: str, runs: int) -> None:
    print(f"\nЧат {model} ({runs} запросов)")
    plain: list[float] = []
    first: list[float] = []
    total: list[float] = []
    sentence: list[float] = []
    for _ in range(runs):
        started = time.perf_counter()
        r = await client.post(
            f"{base}/chat/completions", headers=headers, json={"model": model, "messages": CHAT_PROMPT, "max_tokens": 200}
        )
        r.raise_for_status()
        plain.append(time.perf_counter() - started)

        started = time.perf_counter()
        seen, got_first, got_sentence = "", None, None
        async with client.stream(
            "POST",
            f"{base}/chat/completions",
            headers=headers,
            json={"model": model, "messages": CHAT_PROMPT, "max_tokens": 200, "stream": True},
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:") or line.endswith("[DONE]"):
                    continue
                try:
                    piece = json.loads(line[5:])["choices"][0]["delta"].get("content") or ""
                except (ValueError, KeyError, IndexError):
                    continue
                if piece and got_first is None:
                    got_first = time.perf_counter() - started
                seen += piece
                if got_sentence is None and any(m in seen for m in (". ", "? ", "! ")):
                    got_sentence = time.perf_counter() - started
        total.append(time.perf_counter() - started)
        if got_first is not None:
            first.append(got_first)
        if got_sentence is not None:
            sentence.append(got_sentence)
    print(f"  без стрима, весь ответ:        {median(plain)} с")
    print(f"  стрим, первый токен:           {median(first)} с")
    print(f"  стрим, первое предложение:     {median(sentence)} с")
    print(f"  стрим, до конца:               {median(total)} с")


async def probe_tts(client: httpx.AsyncClient, base: str, headers: dict, model: str, voice: str, runs: int) -> None:
    print(f"\nОзвучка {model}, голос {voice} ({runs} запросов на фразу)")
    for phrase in PHRASES:
        whole: list[float] = []
        first_byte: list[float] = []
        last_byte: list[float] = []
        chunks_seen: list[int] = []
        size = 0
        for _ in range(runs):
            body = {"model": model, "input": phrase, "voice": voice, "response_format": "pcm"}
            started = time.perf_counter()
            r = await client.post(f"{base}/audio/speech", headers=headers, json=body)
            r.raise_for_status()
            whole.append(time.perf_counter() - started)

            started = time.perf_counter()
            first, count, size = None, 0, 0
            async with client.stream("POST", f"{base}/audio/speech", headers=headers, json=body) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    if first is None:
                        first = time.perf_counter() - started
                    count += 1
                    size += len(chunk)
            last_byte.append(time.perf_counter() - started)
            first_byte.append(first or 0.0)
            chunks_seen.append(count)
        seconds = size / 2 / 24_000
        print(f"  «{phrase[:44]}{'…' if len(phrase) > 44 else ''}» ({len(phrase)} зн., звук {seconds:.1f} с)")
        print(
            f"    целиком {median(whole)} с | потоком: первый байт {median(first_byte)} с, "
            f"последний {median(last_byte)} с, кусков {int(statistics.median(chunks_seen))}"
        )
    print("  Если первый байт ≈ последнему и кусок один, прокси собирает ответ целиком: стрим звука не ускорит.")


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--chat-model", default="gigachat3.5-432b-a28b")
    parser.add_argument("--tts-model", default="qwen/qwen-audio-3.0-tts-flash")
    parser.add_argument("--tts-voice", default="longanhuan_v3.6")
    parser.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()

    key = os.environ.get("AGENT_API_TOKEN")
    if not key:
        print("Нужен ключ прокси в окружении: AGENT_API_TOKEN", file=sys.stderr)
        return 2
    headers = {"Authorization": f"Bearer {key}"}
    base = args.base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=60) as client:
        await probe_chat(client, base, headers, args.chat_model, args.runs)
        await probe_tts(client, base, headers, args.tts_model, args.tts_voice, args.runs)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
