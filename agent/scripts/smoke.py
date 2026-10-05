"""Сквозная проверка запущенного агента: REST, WebSocket, голос и озвучка.

    uv run python scripts/smoke.py --url http://127.0.0.1:8001 --token <AGENT_INTERNAL_TOKEN> --wav reply.wav

Ходит так же, как шлюз приложения: с заголовком Authorization и теми же кадрами. Если озвучка включена,
сохраняет голос ответа агента в WAV, чтобы его можно было послушать. Код возврата 1, если что-то не прошло.
"""

import argparse
import asyncio
import json
import os
import struct
import sys
import uuid
import wave

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

failures: list[str] = []


def save_wav(path: str, pcm: bytes) -> None:
    """PCM16 24 кГц моно → WAV, чтобы голос агента можно было послушать."""
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24_000)
        wav.writeframes(pcm)


def check(ok: bool, what: str, detail: str = "") -> bool:
    print(f"  {'OK  ' if ok else 'FAIL'} {what}{(' — ' + detail) if detail and not ok else ''}")
    if not ok:
        failures.append(what)
    return ok


async def read_until(ws, stop, timeout: float = 20.0):
    """Читает кадры, пока stop(json_frames) не вернёт True. Возвращает (json-кадры, двоичные кадры)."""
    texts: list[dict] = []
    audio: list[bytes] = []

    async def pump():
        async for message in ws:
            if isinstance(message, bytes):
                audio.append(message)
            else:
                texts.append(json.loads(message))
            if stop(texts):
                return

    await asyncio.wait_for(pump(), timeout)
    return texts, audio


def kinds(texts: list[dict]) -> list[str]:
    return [t["type"] for t in texts]


async def main(url: str, token: str, wav_path: str | None) -> int:
    auth = {"Authorization": f"Bearer {token}"}
    ws_base = url.replace("http", "ws", 1)
    user = str(uuid.uuid4())

    async with httpx.AsyncClient(base_url=url, timeout=15) as http:
        print("служебные эндпоинты")
        check((await http.get("/health")).status_code == 200, "GET /health без токена")
        ready = await http.get("/health/ready")
        tts = ready.json().get("tts", "none")
        check(ready.status_code == 200, "GET /health/ready", ready.text)
        print(f"  озвучка: {tts}")

        print("REST")
        check((await http.post(f"/v1/users/{user}/dialogs")).status_code == 401, "POST /dialogs без токена → 401")
        started = await http.post(f"/v1/users/{user}/dialogs", headers=auth)
        check(started.status_code == 200 and "dialogId" in started.json(), "POST /dialogs", started.text)
        dialog = started.json()["dialogId"]
        again = (await http.post(f"/v1/users/{user}/dialogs", headers=auth)).json()
        check(again["dialogId"] == dialog and again["resumed"] is True, "повторный POST возвращает тот же диалог")

        print("WebSocket")
        path = f"{ws_base}/v1/users/{user}/dialogs/{dialog}/ws"
        try:
            async with connect(path):
                check(False, "рукопожатие без токена → 401")
        except InvalidStatus as error:
            check(error.response.status_code == 401, "рукопожатие без токена → 401", str(error.response.status_code))

        async with connect(path, additional_headers=auth) as ws:
            texts, audio = await read_until(ws, lambda t: "ready" in kinds(t))
            check(kinds(texts)[0] == "ready", "первым кадром пришёл ready")

            try:
                async with connect(path, additional_headers=auth):
                    check(False, "второй сокет → 409")
            except InvalidStatus as error:
                check(error.response.status_code == 409, "второй сокет к тому же диалогу → 409")

            if tts != "none":
                texts, audio = await read_until(ws, lambda t: "tts_end" in kinds(t))
                check(
                    any(t["type"] == "tts_start" and t["messageId"] == "greeting" for t in texts) and len(audio) > 0,
                    "приветствие озвучено",
                    f"кадров звука: {len(audio)}",
                )

            print("текстовая реплика")
            await ws.send(json.dumps({"type": "user_message", "id": "smoke-1", "text": "Привет, мне грустно"}))
            want = ["assistant_end"] + (["tts_end"] if tts != "none" else [])
            texts, audio = await read_until(ws, lambda t: all(w in kinds(t) for w in want))
            ack = next((t for t in texts if t["type"] == "ack"), None)
            end = next((t for t in texts if t["type"] == "assistant_end"), None)
            check(ack is not None and ack["id"] == "smoke-1", "ack с тем же id")
            deltas = "".join(t["text"] for t in texts if t["type"] == "assistant_delta")
            check(end is not None and deltas == end["text"], "assistant_end.text совпадает со склейкой дельт")
            print(f"  ответ агента: {end['text'] if end else None!r}")
            if tts != "none":
                check(len(audio) > 0, "ответ озвучен", f"кадров звука: {len(audio)}")
                headers_ok = all(frame[0] == 0x02 and len(frame) <= 9605 for frame in audio)
                check(headers_ok, "кадры озвучки: вид 0x02, не больше 9605 байт")
                seconds = sum(len(frame) - 5 for frame in audio) / 2 / 24_000
                print(f"  звук: {len(audio)} кадров, {seconds:.1f} с")
                if wav_path:
                    save_wav(wav_path, b"".join(frame[5:] for frame in audio))
                    print(f"  голос ответа сохранён: {wav_path}")

            print("голосовая реплика")
            await ws.send(json.dumps({"type": "audio_start"}))
            for n in range(20):
                await ws.send(struct.pack(">BI", 0x01, n) + bytes(3200))
            await ws.send(json.dumps({"type": "audio_end"}))
            texts, _ = await read_until(ws, lambda t: "assistant_end" in kinds(t))
            transcript = next((t for t in texts if t["type"] == "transcript"), None)
            check(
                transcript is not None and transcript["final"] and bool(transcript.get("messageId")),
                "final-транскрипт с messageId",
            )
            check("ack" not in kinds(texts), "на голосовую реплику ack не приходит")

            print("завершение")
            await ws.send(json.dumps({"type": "end", "takeaway": "Проверка связи", "tensionAfter": 5}))
            texts, _ = await read_until(ws, lambda t: "ended" in kinds(t))
            check(texts[-1]["type"] == "ended" and texts[-1]["summary"]["title"] == "Проверка связи", "ended со сводкой")
            await ws.wait_closed()
            check(ws.close_code == 1000, "сокет закрыт кодом 1000", str(ws.close_code))

        print("история")
        history = (await http.get(f"/v1/users/{user}/dialogs/{dialog}", headers=auth)).json()
        roles = [m["role"] for m in history["messages"]]
        check(roles == ["user", "assistant", "user", "assistant"], "в истории обе реплики и оба ответа", str(roles))
        check(history["endedAt"] is not None, "диалог завершён")

        print("стирание")
        check((await http.delete(f"/v1/users/{user}", headers=auth)).status_code == 204, "DELETE /users/{id} → 204")
        gone = await http.get(f"/v1/users/{user}/dialogs/{dialog}", headers=auth)
        check(gone.status_code == 404, "после стирания диалога нет → 404")

    print()
    print("ВСЁ ПРОШЛО" if not failures else f"НЕ ПРОШЛО: {len(failures)} — " + "; ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # консоль Windows по умолчанию не знает кириллицы
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--token", default=os.environ.get("AGENT_INTERNAL_TOKEN"))
    parser.add_argument("--wav", help="куда сохранить голос ответа агента (если озвучка включена)")
    args = parser.parse_args()
    if not args.token:
        sys.exit("нужен --token или AGENT_INTERNAL_TOKEN")
    sys.exit(asyncio.run(main(args.url, args.token, args.wav)))
