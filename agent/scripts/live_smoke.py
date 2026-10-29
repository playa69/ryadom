"""Живая сквозная проверка голоса агента против настоящего Gemini Live.

    python scripts/live_smoke.py --url http://127.0.0.1:8011 --token <AGENT_INTERNAL_TOKEN> \
        --pcm-dir <каталог с in_0_16k.pcm … in_4_16k.pcm и in_crisis_16k.pcm> --wav-dir <куда сохранить голос ответов> \
        [--pipeline sber|gemini]

Агент уже запущен (скрипт его не запускает). Скрипт ходит так же, как шлюз приложения: заголовок
Authorization, те же JSON-кадры и двоичные кадры голоса. Входные реплики — готовые PCM16 16 кГц моно (синтезированные
голосом заранее); кризисная фраза «Я больше не хочу жить» лежит в `in_crisis_16k.pcm`.

Сценарии (буква — в отчёте и в `--only`):
  в  приветствие: после `ready` приходит `tts_start` с messageId "greeting"
  а  набранное сообщение: ack, assistant_start, дельты, assistant_end, tts_start, кадры 0x02, tts_end
  з  два хода подряд на одном соединении (контекст сохраняется), затем `end` → `ended` и история в REST
  б  голосовая реплика: transcript (final, messageId) до assistant_start, задержки, длительность звука, WAV
  е  перебивание: `tts_cancel` + новая голосовая реплика поверх озвучки
  ж  `set_voice female`, затем реплика: другой (женский) голос, контекст прежних реплик сохранён
  г  кризис голосом и текстом: transcript, safety, ровно CRISIS_REPLY, ничего от модели
  д  тишина: transcript с пустым text, без ответа (плюс повторное подключение не повторяет приветствие)

Код возврата 1, если хоть одна проверка не прошла. Ключ Gemini скрипту не нужен: он у агента. `--pipeline` — голосовой путь
диалогов (`sber` или `gemini`, PROTEUS-258); без него — путь агента по умолчанию.
"""

import argparse
import asyncio
import json
import os
import re
import statistics
import struct
import sys
import time
import uuid
import wave
from array import array
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

CRISIS_REPLY = CRISIS_SAFETY_TEXT = ""
REPLIES: tuple[str, ...] = ()


def load_replies(token: str) -> None:
    """Фиксированные фразы агента берём из его же кода: конфигурация требует токен в окружении, дальше он не нужен."""
    global CRISIS_REPLY, CRISIS_SAFETY_TEXT, REPLIES
    os.environ.setdefault("AGENT_INTERNAL_TOKEN", token)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from app.services import replies

    # Шаблонных ответов у агента больше нет (`REPLIES` убран из кода): проверка «не шаблон» тогда ничего не отсеивает.
    CRISIS_REPLY, CRISIS_SAFETY_TEXT, REPLIES = replies.CRISIS_REPLY, replies.CRISIS_SAFETY_TEXT, getattr(replies, "REPLIES", ())

IN_FRAME = 1280  # 40 мс PCM16 16 кГц, как у клиента
PIPELINE: str | None = None  # голосовой путь диалогов (`--pipeline`)
TTS_RATE = 24_000
TTS_FRAME_FULL = 5 + 9600  # заголовок + 200 мс
ANSWER_TIMEOUT = 45.0

results: dict[str, list[tuple[bool, str]]] = {}
latencies: list[tuple[str, str, float]] = []  # (сценарий, что измерено, секунды)
current = "?"


def scenario(letter: str, title: str) -> None:
    global current
    current = letter
    results.setdefault(letter, [])
    print(f"\n[{letter}] {title}")


def check(ok: bool, what: str, detail: str = "") -> bool:
    print(f"  {'OK  ' if ok else 'FAIL'} {what}{(' — ' + detail) if detail and not ok else ''}")
    results.setdefault(current, []).append((ok, what + (f" ({detail})" if detail and not ok else "")))
    return ok


def note(text: str) -> None:
    print(f"  ..   {text}")


def measure(what: str, seconds: float) -> None:
    latencies.append((current, what, seconds))
    print(f"  ..   {what}: {seconds:.2f} с")


# ─── соединение ──────────────────────────────────────────────────────────────


@dataclass
class Ev:
    t: float
    type: str  # тип JSON-кадра или "bin" для двоичного
    d: dict = field(default_factory=dict)
    kind: int = 0
    seq: int = -1
    size: int = 0
    data: bytes = b""


class Conn:
    """WebSocket с фоновым чтением: каждый кадр получает метку времени, сценарии ждут нужные кадры."""

    def __init__(self, ws) -> None:  # noqa: ANN001
        self.ws = ws
        self.evs: list[Ev] = []
        self.cond = asyncio.Condition()
        self.done = False
        self.close_code: int | None = None
        self._task = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for message in self.ws:
                t = time.monotonic()
                if isinstance(message, bytes):
                    seq = struct.unpack(">I", message[1:5])[0] if len(message) >= 5 else -1
                    ev = Ev(t, "bin", kind=message[0] if message else -1, seq=seq, size=len(message), data=message[5:])
                else:
                    frame = json.loads(message)
                    ev = Ev(t, str(frame.get("type")), frame)
                async with self.cond:
                    self.evs.append(ev)
                    self.cond.notify_all()
        except ConnectionClosed:
            pass
        finally:
            self.close_code = self.ws.close_code
            async with self.cond:
                self.done = True
                self.cond.notify_all()

    def mark(self) -> int:
        return len(self.evs)

    async def wait(self, since: int, pred, timeout: float):  # noqa: ANN001, ANN201
        """События с метки `since`, когда pred(события) стал истинным; None — не дождались (или сокет закрыт)."""

        async def waiting() -> None:
            async with self.cond:
                await self.cond.wait_for(lambda: pred(self.evs[since:]) or self.done)

        try:
            await asyncio.wait_for(waiting(), timeout)
        except TimeoutError:
            return None
        sl = self.evs[since:]
        return sl if pred(sl) else None

    async def quiet(self, since: int, seconds: float) -> list[Ev]:
        """Подождать и вернуть всё, что пришло с метки."""
        await asyncio.sleep(seconds)
        return self.evs[since:]

    async def send(self, frame: dict) -> float:
        await self.ws.send(json.dumps(frame, ensure_ascii=False))
        return time.monotonic()

    async def close(self) -> None:
        try:
            await self.ws.close()
        except Exception:  # noqa: BLE001
            pass
        await asyncio.gather(self._task, return_exceptions=True)


def types(sl: list[Ev]) -> list[str]:
    return [e.type for e in sl]


def first(sl: list[Ev], type_: str, **match) -> Ev | None:  # noqa: ANN003
    return next((e for e in sl if e.type == type_ and all(e.d.get(k) == v for k, v in match.items())), None)


def has(sl: list[Ev], type_: str, **match) -> bool:  # noqa: ANN003
    return first(sl, type_, **match) is not None


async def send_voice(conn: Conn, pcm: bytes, pace: float, with_start: bool = True) -> float:
    """Голосовая реплика: audio_start, кадры по 40 мс, audio_end. Возвращает момент отправки audio_end."""
    if with_start:
        await conn.send({"type": "audio_start"})
    for n, at in enumerate(range(0, len(pcm), IN_FRAME)):
        chunk = pcm[at : at + IN_FRAME].ljust(IN_FRAME, b"\x00")
        await conn.ws.send(struct.pack(">BI", 0x01, n) + chunk)
        if pace:
            await asyncio.sleep(pace)
    return await conn.send({"type": "audio_end"})


# ─── разбор ответа ───────────────────────────────────────────────────────────


@dataclass
class Answer:
    mid: str | None
    start: Ev | None
    deltas: list[Ev]
    end: Ev | None
    tts_start: Ev | None
    tts_end: Ev | None
    frames: list[Ev]

    @property
    def text(self) -> str:
        return self.end.d.get("text", "") if self.end else ""

    @property
    def pcm(self) -> bytes:
        return b"".join(f.data for f in self.frames)

    @property
    def seconds(self) -> float:
        return len(self.pcm) / 2 / TTS_RATE


def parse_answer(sl: list[Ev], mid: str | None = None) -> Answer:
    start = first(sl, "assistant_start", **({"messageId": mid} if mid else {}))
    mid = mid or (start.d.get("messageId") if start else None)
    deltas = [e for e in sl if e.type == "assistant_delta" and e.d.get("messageId") == mid]
    end = first(sl, "assistant_end", messageId=mid) if mid else None
    tts_start = first(sl, "tts_start", messageId=mid) if mid else None
    tts_end = first(sl, "tts_end", messageId=mid) if mid else None
    frames: list[Ev] = []
    if tts_start is not None:
        i0 = sl.index(tts_start)
        i1 = sl.index(tts_end) if tts_end is not None else len(sl)
        frames = [e for e in sl[i0:i1] if e.type == "bin"]
    return Answer(mid, start, deltas, end, tts_start, tts_end, frames)


def answered(sl: list[Ev]) -> bool:
    """Ответ закончен: текст дописан и озвучка закрыта."""
    return has(sl, "assistant_end") and has(sl, "tts_end")


def cyrillic_share(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    return sum("а" <= c.lower() <= "я" or c.lower() == "ё" for c in letters) / len(letters) if letters else 0.0


def check_frames(frames: list[Ev], label: str) -> None:
    check(bool(frames), f"{label}: кадры озвучки пришли", f"кадров: {len(frames)}")
    if not frames:
        return
    check(all(f.kind == 0x02 for f in frames), f"{label}: кадры вида 0x02")
    check([f.seq for f in frames] == list(range(len(frames))), f"{label}: нумерация с 0 без пропусков")
    check(all(5 < f.size <= TTS_FRAME_FULL for f in frames), f"{label}: кадр не длиннее 9605 байт")
    short = [i for i, f in enumerate(frames[:-1]) if f.size != TTS_FRAME_FULL]
    if short:
        note(f"{label}: короткие кадры не в конце: {len(short)} (на стыках предложений)")


def check_answer(
    label: str, ans: Answer, sent_at: float, expect_audio: bool = True, is_voice: bool = False, min_chars: int = 15
) -> None:
    check(ans.start is not None, f"{label}: assistant_start")
    check(bool(ans.deltas), f"{label}: assistant_delta пришли", f"дельт: {len(ans.deltas)}")
    check(ans.end is not None, f"{label}: assistant_end")
    joined = "".join(d.d.get("text", "") for d in ans.deltas)
    check(
        ans.end is not None and joined == ans.text,
        f"{label}: сумма дельт строго равна assistant_end.text",
        f"дельты={joined!r} end={ans.text!r}",
    )
    text = ans.text
    note(f"ответ: {text!r}")
    check(len(text.strip()) >= min_chars, f"{label}: ответ не пустой", repr(text))
    check(cyrillic_share(text) >= 0.8, f"{label}: ответ по-русски", f"доля кириллицы {cyrillic_share(text):.2f}")
    check(text.strip() not in REPLIES, f"{label}: это не шаблонный запасной ответ")
    sentences = len([s for s in re.split(r"(?<=[.!?…])\s+", text.strip()) if s])
    note(f"предложений: {sentences}")
    if ans.start and ans.deltas:
        measure(f"{label}: от {'audio_end' if is_voice else 'отправки'} до assistant_start", ans.start.t - sent_at)
        measure(f"{label}: от {'audio_end' if is_voice else 'отправки'} до первого assistant_delta", ans.deltas[0].t - sent_at)
    if not expect_audio:
        return
    check(ans.tts_start is not None, f"{label}: tts_start")
    check(ans.tts_end is not None, f"{label}: tts_end")
    if ans.tts_start is not None:
        measure(f"{label}: от {'audio_end' if is_voice else 'отправки'} до tts_start", ans.tts_start.t - sent_at)
        if ans.end is not None:
            lag = ans.tts_start.t - ans.end.t
            check(lag <= 0.9, f"{label}: tts_start не позже 0,9 с после assistant_end", f"{lag:+.2f} с")
            note(f"tts_start - assistant_end = {lag:+.2f} с")
    check_frames(ans.frames, label)
    if ans.frames:
        secs = ans.seconds
        rate = len(text) / secs if secs else 0
        check(0.5 <= secs <= 45 and 4 <= rate <= 30, f"{label}: длительность звука разумна", f"{secs:.1f} с на {len(text)} знаков")
        note(f"звук: {len(ans.frames)} кадров, {secs:.1f} с, {rate:.1f} знаков/с")
        gaps = [b.t - a.t for a, b in zip(ans.frames, ans.frames[1:])]
        if gaps:
            note(f"паузы между кадрами: макс {max(gaps) * 1000:.0f} мс, медиана {statistics.median(gaps) * 1000:.0f} мс")


def save_wav(path: Path, pcm: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(TTS_RATE)
        wav.writeframes(pcm)
    note(f"голос сохранён: {path}")


def f0_median(pcm24: bytes) -> float | None:
    """Грубая оценка основного тона (Гц) по автокорреляции: чтобы отличить мужской голос от женского без слуха."""
    s = array("h")
    s.frombytes(pcm24[: len(pcm24) // 2 * 2])
    x = [(s[i] + s[i + 1] + s[i + 2]) / 3 for i in range(0, len(s) - 2, 3)]  # 8 кГц
    frame, lo, hi = 400, 20, 114  # 400..70 Гц
    values: list[float] = []
    for at in range(0, len(x) - frame - hi, frame):
        w = x[at : at + frame + hi]
        e0 = sum(v * v for v in w[:frame])
        if e0 / frame < 500**2:
            continue
        best_lag, best = 0, 0.0
        for lag in range(lo, hi):
            r = sum(w[i] * w[i + lag] for i in range(frame))
            e1 = sum(v * v for v in w[lag : lag + frame])
            norm = r / ((e0 * e1) ** 0.5 + 1e-9)
            if norm > best:
                best, best_lag = norm, lag
        if best > 0.6:
            values.append(8000 / best_lag)
    return statistics.median(values) if len(values) >= 5 else None


# ─── общие шаги ──────────────────────────────────────────────────────────────


async def open_dialog(http: httpx.AsyncClient, auth: dict, user: str, voice: str | None = None) -> dict:
    body = {**({"voice": voice} if voice else {}), **({"pipeline": PIPELINE} if PIPELINE else {})}
    started = await http.post(f"/v1/users/{user}/dialogs", headers=auth, json=body or None)
    check(started.status_code == 200 and "dialogId" in started.json(), "POST /dialogs", started.text)
    return started.json()


async def open_socket(ws_base: str, auth: dict, user: str, dialog: str) -> Conn:
    ws = await connect(f"{ws_base}/v1/users/{user}/dialogs/{dialog}/ws", additional_headers=auth, max_size=None)
    return Conn(ws)


async def reopen_socket(ws_base: str, auth: dict, user: str, dialog: str) -> tuple[Conn, int, float]:
    """Подключиться сразу после закрытия прежнего сокета. Возвращает сокет, число отказов 409 и сколько они длились."""
    began, refused = time.monotonic(), 0
    while True:
        try:
            return await open_socket(ws_base, auth, user, dialog), refused, time.monotonic() - began
        except InvalidStatus as error:
            if error.response.status_code != 409 or time.monotonic() - began > 10:
                raise
            refused += 1
            await asyncio.sleep(0.05)


async def greeting(conn: Conn, wav_dir: Path | None, label: str, wav_name: str) -> None:
    """Приветствие первого сокета: ready → tts_start "greeting" → кадры → tts_end."""
    sl = await conn.wait(0, lambda s: has(s, "tts_end", messageId="greeting"), 15)
    sl = sl if sl is not None else conn.evs[:]
    ready = first(sl, "ready")
    check(ready is not None and sl[0].type == "ready", f"{label}: первым кадром ready")
    check(all(e.d.get("v") == 1 for e in sl if e.type != "bin"), f"{label}: во всех JSON-кадрах v=1")
    ts = first(sl, "tts_start", messageId="greeting")
    check(ts is not None, f"{label}: tts_start с messageId \"greeting\"")
    if ready is not None and ts is not None:
        lag = ts.t - ready.t
        measure(f"{label}: от ready до tts_start приветствия", lag)
        check(lag <= 0.9, f"{label}: tts_start приветствия не позже 0,9 с после ready (иначе клиент читает сам)", f"{lag:.2f} с")
    ans = parse_answer(sl, "greeting")
    check(ans.tts_end is not None, f"{label}: tts_end приветствия")
    check_frames(ans.frames, f"{label}: приветствие")
    if ans.frames:
        note(f"приветствие: {len(ans.frames)} кадров, {ans.seconds:.1f} с")
        if wav_dir:
            save_wav(wav_dir / wav_name, ans.pcm)
    check(not has(sl, "error"), f"{label}: без error", str([e.d for e in sl if e.type == "error"]))


async def ask_text(  # noqa: ANN201
    conn: Conn, text: str, cid: str, label: str, wav_dir: Path | None, wav_name: str | None = None, min_chars: int = 15
):
    since = conn.mark()
    sent = await conn.send({"type": "user_message", "id": cid, "text": text})
    sl = await conn.wait(since, answered, ANSWER_TIMEOUT)
    check(sl is not None, f"{label}: ответ с озвучкой дошёл до tts_end (не дольше {ANSWER_TIMEOUT:.0f} с)", f"получено: {types(conn.evs[since:])[:12]}")
    sl = sl if sl is not None else conn.evs[since:]
    ack = first(sl, "ack")
    check(ack is not None and ack.d.get("id") == cid, f"{label}: ack с тем же id")
    if ack:
        measure(f"{label}: до ack", ack.t - sent)
    ans = parse_answer(sl)
    if ack and ans.start:
        check(sl.index(ack) < sl.index(ans.start), f"{label}: ack раньше assistant_start")
    check_answer(label, ans, sent, min_chars=min_chars)
    check(not has(sl, "error"), f"{label}: без error", str([e.d for e in sl if e.type == "error"]))
    if wav_dir and wav_name and ans.frames:
        save_wav(wav_dir / wav_name, ans.pcm)
    return ans, sl


async def ask_voice(  # noqa: ANN201
    conn: Conn, pcm: bytes, pace: float, label: str, wav_dir: Path | None, wav_name: str | None = None, with_start: bool = True
):
    since = conn.mark()
    sent = await send_voice(conn, pcm, pace, with_start)
    sl = await conn.wait(since, answered, ANSWER_TIMEOUT)
    check(sl is not None, f"{label}: ответ с озвучкой дошёл до tts_end (не дольше {ANSWER_TIMEOUT:.0f} с)", f"получено: {types(conn.evs[since:])[:12]}")
    sl = sl if sl is not None else conn.evs[since:]
    tr = first(sl, "transcript")
    check(tr is not None and tr.d.get("final") is True and bool(tr.d.get("text")) and bool(tr.d.get("messageId")), f"{label}: transcript final с text и messageId")
    ans = parse_answer(sl)
    if tr is not None:
        note(f"распознано: {tr.d.get('text')!r}")
        measure(f"{label}: от audio_end до transcript", tr.t - sent)
        if ans.start:
            check(sl.index(tr) < sl.index(ans.start), f"{label}: transcript раньше assistant_start", f"{types(sl)[:8]}")
    check(not has(sl, "ack"), f"{label}: на голосовую реплику ack не приходит")
    check_answer(label, ans, sent, is_voice=True)
    check(not has(sl, "error"), f"{label}: без error", str([e.d for e in sl if e.type == "error"]))
    if wav_dir and wav_name and ans.frames:
        save_wav(wav_dir / wav_name, ans.pcm)
    return ans, sl, tr


# ─── сценарии ────────────────────────────────────────────────────────────────


async def main_dialog(http, auth, ws_base, pcm, pace, wav_dir, only) -> None:  # noqa: ANN001
    user = str(uuid.uuid4())
    scenario("в", "приветствие")
    started = await open_dialog(http, auth, user)
    dialog = started["dialogId"]
    note(f"greeting из REST: {started.get('greeting')!r}, голос диалога: {started.get('voice')}")
    check(started.get("resumed") is False, "новый диалог: resumed=false")
    conn = await open_socket(ws_base, auth, user, dialog)
    stored: list[tuple[str, str, str]] = []  # (роль, id, текст) в порядке появления, для сверки с историей REST
    male_pcm = b""
    try:
        await greeting(conn, wav_dir, "в", "v_greeting.wav")

        if "а" in only:
            scenario("а", "набранное сообщение")
            ans, sl = await ask_text(conn, "Привет. Меня зовут Алексей, и сегодня у меня был тяжёлый день.", "c-1", "а", wav_dir, "a_text_reply.wav")
            ack = first(sl, "ack")
            if ack:
                stored += [("user", ack.d["messageId"], "Привет. Меня зовут Алексей, и сегодня у меня был тяжёлый день."), ("assistant", ans.mid, ans.text)]
            male_pcm += ans.pcm

        if "з" in only:
            scenario("з", "два хода подряд на одном соединении, контекст")
            ans, sl = await ask_text(conn, "Как меня зовут? Ответь одним словом.", "c-2", "з: второй ход", wav_dir, "z_second_turn.wav", min_chars=4)
            check("алексей" in ans.text.lower(), "з: второй ход помнит имя из первого (контекст сессии)", repr(ans.text))
            ack = first(sl, "ack")
            if ack:
                stored += [("user", ack.d["messageId"], "Как меня зовут? Ответь одним словом."), ("assistant", ans.mid, ans.text)]
            male_pcm += ans.pcm
            # повтор того же id не даёт второго ответа
            since = conn.mark()
            await conn.send({"type": "user_message", "id": "c-2", "text": "Как меня зовут? Ответь одним словом."})
            sl2 = await conn.quiet(since, 3.0)
            check(has(sl2, "ack") and not has(sl2, "assistant_start"), "з: повтор user_message с тем же id — только ack, без второго ответа", str(types(sl2)))

        if "б" in only:
            scenario("б", "голосовая реплика (in_0)")
            ans, sl, tr = await ask_voice(conn, pcm["in_0"], pace, "б", wav_dir, "b_voice_reply.wav")
            if tr is not None:
                heard = tr.d.get("text", "").lower()
                check(any(k in heard for k in ("тревож", "работ", "валит")), "б: расшифровка похожа на сказанное", repr(heard))
                stored += [("user", tr.d.get("messageId"), tr.d.get("text")), ("assistant", ans.mid, ans.text)]
            male_pcm += ans.pcm

        if "е" in only:
            scenario("е", "перебивание: tts_cancel и новая голосовая реплика поверх озвучки")
            since = conn.mark()
            await send_voice(conn, pcm["in_1"], pace)
            sl = await conn.wait(since, lambda s: sum(e.type == "bin" for e in s) >= 3 and has(s, "tts_start"), ANSWER_TIMEOUT)
            check(sl is not None, "е: озвучка первого ответа пошла (не меньше 3 кадров)")
            if sl is not None:
                old = first(sl, "tts_start")
                old_mid = old.d["messageId"]
                tr1 = first(sl, "transcript")
                if tr1 is not None and tr1.d.get("messageId"):
                    stored.append(("user", tr1.d["messageId"], tr1.d["text"]))
                note(f"первый ответ озвучивается: {old_mid}, кадров к моменту отмены: {sum(e.type == 'bin' for e in conn.evs[since:])}")
                cut = conn.mark()
                t_cancel = await conn.send({"type": "tts_cancel", "messageId": old_mid})
                sent = await send_voice(conn, pcm["in_2"], pace)  # audio_start сразу после tts_cancel, как у клиента
                sl2 = await conn.wait(cut, lambda s: has(s, "tts_end", messageId=old_mid) and answered([e for e in s if e.d.get("messageId") != old_mid]), ANSWER_TIMEOUT)
                check(sl2 is not None, "е: старая озвучка закрыта tts_end, на новую реплику пришёл ответ")
                sl2 = sl2 if sl2 is not None else conn.evs[cut:]
                old_end = first(sl2, "tts_end", messageId=old_mid)
                new_start = next((e for e in sl2 if e.type == "tts_start" and e.d.get("messageId") != old_mid), None)
                # кадры, пришедшие после tts_cancel и до нового tts_start, принадлежат старой озвучке
                stray = [e for e in sl2 if e.type == "bin" and (new_start is None or e.t < new_start.t)]
                late = [e for e in stray if e.t - t_cancel > 0.4]
                check(not late, "е: кадры отменённой озвучки прекратились (позже 0,4 с после tts_cancel их нет)", f"{len(late)} кадров")
                check(len(stray) <= 3, "е: после tts_cancel ушло не больше 3 кадров (то, что было в пути)", f"{len(stray)} кадров")
                note(f"после tts_cancel пришло кадров старого ответа: {len(stray)}")
                if old_end is not None:
                    after_end = [e for e in sl2 if e.type == "bin" and e.t > old_end.t and (new_start is None or e.t < new_start.t)]
                    check(not after_end, "е: после tts_end старого сообщения кадров нет до нового tts_start", f"{len(after_end)}")
                    measure("е: от tts_cancel до tts_end старого сообщения", old_end.t - t_cancel)
                tr = first(sl2, "transcript")
                check(tr is not None and tr.d.get("final") is True and bool(tr.d.get("text")) and bool(tr.d.get("messageId")), "е: transcript новой реплики (не принят за эхо)")
                if tr is not None:
                    note(f"новая реплика распознана: {tr.d.get('text')!r}")
                new_ans = parse_answer([e for e in sl2 if e.d.get("messageId") != old_mid or e.type == "bin"])
                check(new_ans.mid is not None and new_ans.mid != old_mid, "е: ответ на новую реплику — другое сообщение")
                if new_ans.mid:
                    check_answer("е: новый ответ", parse_answer(sl2, new_ans.mid), sent, is_voice=True)
                    if tr and tr.d.get("messageId"):
                        stored += [("user", tr.d["messageId"], tr.d["text"]), ("assistant", new_ans.mid, parse_answer(sl2, new_ans.mid).text)]
                    if wav_dir and new_ans.frames:
                        save_wav(wav_dir / "e_interrupt_new_reply.wav", parse_answer(sl2, new_ans.mid).pcm)
                check(not has(sl2, "error"), "е: без error", str([e.d for e in sl2 if e.type == "error"]))
                # история старого (прерванного) ответа: проверим в REST ниже, id нужен для сверки
                prev_assistant = next((e for e in sl if e.type == "assistant_start" and e.d.get("messageId") == old_mid), None)
                if prev_assistant is not None:
                    end_old = first(sl2, "assistant_end", messageId=old_mid) or first(sl, "assistant_end", messageId=old_mid)
                    old_text = end_old.d["text"] if end_old else None
                    stored.insert(len(stored) - 2, ("assistant", old_mid, old_text))  # перед новой репликой человека

        if "ж" in only:
            scenario("ж", "set_voice female, затем реплика; контекст сохранён")
            ref = f0_median(male_pcm) if male_pcm else None
            note(f"тон мужского голоса (до смены): {ref and round(ref)} Гц")
            await conn.send({"type": "set_voice", "voice": "female"})
            ans, sl, tr = await ask_voice(conn, pcm["in_3"], pace, "ж: голосом", wav_dir, "f_female_voice.wav")
            if tr is not None:
                stored += [("user", tr.d.get("messageId"), tr.d.get("text")), ("assistant", ans.mid, ans.text)]
            fem = f0_median(ans.pcm) if ans.pcm else None
            note(f"тон женского голоса (после смены): {fem and round(fem)} Гц")
            if ref and fem:
                check(fem > ref * 1.15, "ж: тон ответа выше, чем у прежнего голоса (другой, женский голос)", f"{fem:.0f} Гц против {ref:.0f} Гц")
            else:
                note("тон оценить не удалось (мало озвученных кадров)")
            ans2, sl2 = await ask_text(conn, "Напомни, как меня зовут и что тревожило на работе? Ответь одной фразой.", "c-3", "ж: контекст", wav_dir, "f_female_context.wav")
            low = ans2.text.lower()
            check("алексей" in low, "ж: после смены голоса модель помнит имя из первых реплик", repr(ans2.text))
            check("работ" in low or "тревож" in low, "ж: после смены голоса модель помнит про работу/тревогу", repr(ans2.text))
            ack = first(sl2, "ack")
            if ack:
                stored += [("user", ack.d["messageId"], "Напомни, как меня зовут и что тревожило на работе? Ответь одной фразой."), ("assistant", ans2.mid, ans2.text)]
            fem2 = f0_median(ans2.pcm) if ans2.pcm else None
            note(f"тон второго женского ответа: {fem2 and round(fem2)} Гц")

        scenario("з", "завершение и история")
        since = conn.mark()
        await conn.send({"type": "end", "takeaway": "Живая проверка", "tensionAfter": 4})
        sl = await conn.wait(since, lambda s: has(s, "ended"), 15)
        check(sl is not None, "end → ended")
        if sl is not None:
            ended = first(sl, "ended")
            check(ended.d.get("summary", {}).get("title") == "Живая проверка", "ended со сводкой", str(ended.d))
        await asyncio.wait_for(conn.ws.wait_closed(), 10)
        check(conn.ws.close_code == 1000, "сокет закрыт кодом 1000", str(conn.ws.close_code))
    finally:
        await conn.close()

    history = await http.get(f"/v1/users/{user}/dialogs/{dialog}", headers=auth)
    check(history.status_code == 200, "GET диалога", history.text[:200])
    body = history.json()
    msgs = body.get("messages", [])
    note(f"в истории {len(msgs)} сообщений, роли: {[m['role'][0] for m in msgs]}")
    check(body.get("endedAt") is not None, "диалог завершён (endedAt)")
    got = [(m["role"], m["id"], m["text"]) for m in msgs]
    want = [(r, i, t) for r, i, t in stored if i]
    missing = [w for w in want if w not in got]
    check(not missing, "з: все реплики и ответы из сеанса сохранены с теми же id и текстом", f"нет в истории: {missing[:3]}")
    order_ok = [g[1] for g in got if g[1] in {w[1] for w in want}] == [w[1] for w in want]
    check(order_ok, "з: порядок сообщений в истории совпадает с порядком в разговоре")
    roles = [m["role"] for m in msgs]
    check(all(roles[i] != roles[i + 1] for i in range(len(roles) - 1)), "з: роли в истории чередуются", str(roles))


async def crisis_dialog(http, auth, ws_base, pcm, pace, wav_dir) -> None:  # noqa: ANN001
    user = str(uuid.uuid4())
    started = await open_dialog(http, auth, user)
    conn = await open_socket(ws_base, auth, user, started["dialogId"])
    try:
        scenario("г", "кризис голосом и текстом")
        await greeting(conn, wav_dir, "г", "g_greeting.wav")

        since = conn.mark()
        sent = await send_voice(conn, pcm["in_crisis"], pace)
        sl = await conn.wait(since, lambda s: has(s, "assistant_end") and has(s, "tts_end"), ANSWER_TIMEOUT)
        check(sl is not None, "г голос: фиксированный ответ дошёл до tts_end", f"получено: {types(conn.evs[since:])[:12]}")
        sl = sl if sl is not None else conn.evs[since:]
        tr, sf = first(sl, "transcript"), first(sl, "safety")
        a_start = first(sl, "assistant_start")
        note(f"последовательность: {types([e for e in sl if e.type != 'bin' and e.type != 'assistant_delta'])}")
        check(tr is not None and tr.d.get("final") is True and bool(tr.d.get("messageId")), "г голос: transcript final с messageId")
        if tr:
            note(f"распознано: {tr.d.get('text')!r}")
            measure("г голос: от audio_end до transcript", tr.t - sent)
        check(sf is not None and sf.d.get("text") == CRISIS_SAFETY_TEXT, "г голос: safety с текстом деэскалации", str(sf and sf.d))
        if sf:
            measure("г голос: от audio_end до safety", sf.t - sent)
        if tr and sf and a_start:
            check(sl.index(tr) < sl.index(sf) < sl.index(a_start), "г голос: порядок transcript → safety → assistant_start")
        deltas_before = [e for e in sl if e.type == "assistant_delta" and sf is not None and e.t < sf.t]
        check(not deltas_before, "г голос: до safety никаких слов ответа", f"{len(deltas_before)} дельт")
        ans = parse_answer(sl)
        joined = "".join(d.d["text"] for d in ans.deltas)
        check(ans.text == CRISIS_REPLY and joined == CRISIS_REPLY, "г голос: ответ ровно CRISIS_REPLY (ничего от модели)", f"end={ans.text!r}")
        check(ans.tts_start is not None and ans.tts_end is not None, "г голос: ответ озвучен")
        check_frames(ans.frames, "г голос")
        if ans.frames:
            secs = ans.seconds
            check(4 <= secs <= 25, "г голос: длительность озвучки CRISIS_REPLY разумна", f"{secs:.1f} с на {len(CRISIS_REPLY)} знаков")
            note(f"озвучка CRISIS_REPLY: {secs:.1f} с")
            if wav_dir:
                save_wav(wav_dir / "g_crisis_voice_reply.wav", ans.pcm)
        if ans.tts_start:
            measure("г голос: от audio_end до tts_start", ans.tts_start.t - sent)
        extra = await conn.quiet(conn.evs.index(sl[-1]) + 1, 5.0)
        check(not has(extra, "assistant_start") and not has(extra, "assistant_delta") and not has(extra, "tts_start"), "г голос: через 5 с после ответа от модели ничего не просочилось", str(types(extra)[:8]))
        check(not has(sl + extra, "error"), "г голос: без error", str([e.d for e in sl + extra if e.type == "error"]))

        # кризис текстом
        since = conn.mark()
        sent = await conn.send({"type": "user_message", "id": "k-1", "text": "Я больше не хочу жить"})
        sl = await conn.wait(since, lambda s: has(s, "assistant_end") and has(s, "tts_end"), ANSWER_TIMEOUT)
        check(sl is not None, "г текст: фиксированный ответ дошёл до tts_end", f"получено: {types(conn.evs[since:])[:12]}")
        sl = sl if sl is not None else conn.evs[since:]
        ack, sf, a_start = first(sl, "ack"), first(sl, "safety"), first(sl, "assistant_start")
        check(ack is not None and ack.d.get("id") == "k-1", "г текст: ack")
        check(sf is not None and sf.d.get("text") == CRISIS_SAFETY_TEXT, "г текст: safety")
        if ack and sf and a_start:
            check(sl.index(ack) < sl.index(sf) < sl.index(a_start), "г текст: порядок ack → safety → assistant_start")
        ans = parse_answer(sl)
        check(ans.text == CRISIS_REPLY and "".join(d.d["text"] for d in ans.deltas) == CRISIS_REPLY, "г текст: ответ ровно CRISIS_REPLY", f"end={ans.text!r}")
        check(ans.tts_start is not None and ans.tts_end is not None, "г текст: ответ озвучен")
        if ans.tts_start:
            measure("г текст: от отправки до tts_start", ans.tts_start.t - sent)
        extra = await conn.quiet(conn.evs.index(sl[-1]) + 1, 4.0)
        check(not has(extra, "assistant_start") and not has(extra, "tts_start"), "г текст: от модели ничего не просочилось", str(types(extra)[:8]))

        # после кризиса сессия с моделью жива
        ans, _ = await ask_text(conn, "Спасибо, что ты рядом. Мне чуть спокойнее.", "k-2", "г: после кризиса", wav_dir, "g_after_crisis.wav")
        check(ans.text != CRISIS_REPLY, "г: после кризиса обычный ответ модели, а не повтор кризисного")
    finally:
        await conn.close()


async def silence_dialog(http, auth, ws_base, pace, wav_dir) -> None:  # noqa: ANN001
    user = str(uuid.uuid4())
    started = await open_dialog(http, auth, user)
    dialog = started["dialogId"]
    conn = await open_socket(ws_base, auth, user, dialog)
    try:
        scenario("д", "тишина")
        await greeting(conn, wav_dir, "д", "d_greeting.wav")
        since = conn.mark()
        await conn.send({"type": "audio_start"})
        for n in range(20):
            await conn.ws.send(struct.pack(">BI", 0x01, n) + bytes(IN_FRAME))
            if pace:
                await asyncio.sleep(pace)
        t_end = await conn.send({"type": "audio_end"})
        sl = await conn.wait(since, lambda s: has(s, "transcript"), 10)
        check(sl is not None, "д: transcript на тишину пришёл")
        if sl is not None:
            tr = first(sl, "transcript")
            check(tr.d.get("final") is True and tr.d.get("text") == "" and "messageId" not in tr.d, "д: transcript final с text \"\" и без messageId", str(tr.d))
            measure("д: от audio_end до пустого transcript", tr.t - t_end)
        rest = await conn.quiet(since, 4.0)
        check(not any(e.type in ("assistant_start", "assistant_delta", "tts_start", "safety", "error") for e in rest), "д: ответа на тишину нет", str(types(rest)))
        check(sum(e.type == "transcript" for e in rest) == 1, "д: ровно один transcript")

        # приветствие не повторяется на втором сокете того же POST
        await conn.close()
        await asyncio.sleep(0.5)
        scenario("в", "приветствие: повторное подключение и повторный POST")
        conn = await open_socket(ws_base, auth, user, dialog)
        sl = await conn.quiet(0, 4.0)
        check(has(sl, "ready"), "в: второй сокет — ready")
        check(not has(sl, "tts_start"), "в: приветствие на втором сокете не повторяется", str(types(sl)[:8]))
        await conn.close()
        started2 = await open_dialog(http, auth, user)
        check(started2.get("dialogId") == dialog and started2.get("resumed") is True, "в: повторный POST возвращает тот же диалог, resumed=true")
        conn, refused, window = await reopen_socket(ws_base, auth, user, dialog)
        note(f"подключение сразу после закрытия прежнего сокета: отказов 409 — {refused}, окно {window:.2f} с")
        check(refused == 0, "в: подключение сразу после закрытия прежнего сокета принято, без 409", f"{refused} отказов за {window:.2f} с")
        sl = await conn.wait(0, lambda s: has(s, "tts_end", messageId="greeting"), 15)
        check(sl is not None and has(sl, "tts_start", messageId="greeting"), "в: после повторного POST приветствие озвучено снова", str(types(conn.evs)[:8]))
        if sl:
            ts, ready = first(sl, "tts_start"), first(sl, "ready")
            if ts and ready:
                measure("в: resumed — от ready до tts_start приветствия", ts.t - ready.t)
    finally:
        await conn.close()


async def run(args) -> int:  # noqa: ANN001
    load_replies(args.token)
    auth = {"Authorization": f"Bearer {args.token}"}
    ws_base = args.url.replace("http", "ws", 1)
    pcm_dir = Path(args.pcm_dir)
    pcm = {name: (pcm_dir / f"{name}_16k.pcm").read_bytes() for name in ("in_0", "in_1", "in_2", "in_3", "in_crisis")}
    wav_dir = Path(args.wav_dir) if args.wav_dir else None
    only = set(args.only) if args.only else set("авбезжгд")

    async with httpx.AsyncClient(base_url=args.url, timeout=20) as http:
        print("служебные эндпоинты")
        ready = await http.get("/health/ready")
        info = ready.json()
        scenario("0", "стенд")
        check(ready.status_code == 200, "GET /health/ready", ready.text)
        check(str(info.get("pipeline", "")).startswith("gemini-live"), "Gemini Live есть (основной или запасной путь)", str(info))
        note(f"голосовой путь диалогов: {PIPELINE or info.get('voicePipeline', 'gemini')}")
        note(f"готовность: {info}")
        user0 = str(uuid.uuid4())
        check((await http.post(f"/v1/users/{user0}/dialogs")).status_code == 401, "POST /dialogs без токена → 401")

        if only & set("авзбеж"):
            await main_dialog(http, auth, ws_base, pcm, args.pace, wav_dir, only)
        if "г" in only:
            await crisis_dialog(http, auth, ws_base, pcm, args.pace, wav_dir)
        if "д" in only:
            await silence_dialog(http, auth, ws_base, args.pace, wav_dir)

    print("\n" + "=" * 70)
    print("ИТОГ ПО СЦЕНАРИЯМ")
    names = {"0": "стенд", "в": "приветствие", "а": "набранное сообщение", "з": "два хода, контекст, end, история", "б": "голос (in_0)", "е": "перебивание", "ж": "set_voice female + контекст", "г": "кризис голосом/текстом", "д": "тишина"}
    for letter in "0вазбежгд":
        checks = results.get(letter)
        if not checks:
            continue
        bad = [what for ok, what in checks if not ok]
        print(f"  [{letter}] {names[letter]:<34} {'ПРОШЁЛ' if not bad else 'НЕ ПРОШЁЛ'}  ({len(checks) - len(bad)}/{len(checks)})")
        for what in bad:
            print(f"        - {what}")
    print("\nЗАДЕРЖКИ")
    for letter, what, seconds in latencies:
        print(f"  [{letter}] {what}: {seconds:.2f} с")
    failed = sum(not ok for checks in results.values() for ok, _ in checks)
    print("\nВСЁ ПРОШЛО" if not failed else f"\nНЕ ПРОШЛО проверок: {failed}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # консоль Windows по умолчанию не знает кириллицы
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8011")
    parser.add_argument("--token", default=os.environ.get("AGENT_INTERNAL_TOKEN"))
    parser.add_argument("--pcm-dir", required=True, help="каталог с in_0_16k.pcm … in_3_16k.pcm и in_crisis_16k.pcm")
    parser.add_argument("--wav-dir", help="куда сохранить голос ответов (WAV 24 кГц) для прослушивания")
    parser.add_argument("--pace", type=float, default=0.02, help="пауза между кадрами голоса, с (0,04 — реальное время)")
    parser.add_argument("--only", help="только эти сценарии, буквами без разделителей, например: авб")
    parser.add_argument("--pipeline", choices=("sber", "gemini"), help="голосовой путь диалогов; без него — путь агента по умолчанию")
    args = parser.parse_args()
    PIPELINE = args.pipeline
    if not args.token:
        sys.exit("нужен --token или AGENT_INTERNAL_TOKEN")
    sys.exit(asyncio.run(run(args)))
