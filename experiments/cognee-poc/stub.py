"""Болванка PoC: диалог с памятью Cognee + LLM через gpt2giga, текст и голос.

Поток: /chat и /voice → recall фактов из Cognee (датасет юзера) → GigaChat через gpt2giga → ответ.
Реплики копятся в памяти процесса; POST /dialog/end отправляет транскрипт в Cognee (remember →
граф строится на сервере, до минуты-двух) и чистит буфер.
Голос: /voice принимает webm с микрофона, распознаёт whisper'ом на прокси shared1 (ключ берётся
из agent-secrets в кластере, не печатается), ответ озвучивается macOS `say` (Милена).
UI для проверки: http://127.0.0.1:8090/

    COGNEE_MCP_USER=... COGNEE_MCP_PASS=... .venv/bin/python stub.py   # http://127.0.0.1:8090
"""

import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time
from collections import defaultdict
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from cognee_mcp import CogneeMCP
from cognee_rest import CogneeREST

GPT2GIGA_URL = "http://127.0.0.1:8400/v1/chat/completions"
MODEL = "GigaChat-3-Pro"
PROXY_URL = "https://shared1.multitool.works:4000/v1"
KUBECONFIG = Path(__file__).resolve().parents[2] / "admin-kubeconfig.yaml"

SYSTEM = """Ты — тёплый ИИ-собеседник психологической поддержки сервиса «Рядом». Тебя зовут Рядом.
Всегда говори о себе только в мужском роде: твой голос и грамматический род — мужской.
Всегда отвечай только по-русски, независимо от языка и разборчивости входной речи.
Если реплика неразборчива или похожа на шум, попроси по-русски повторить; не угадывай язык и не переходи на него.
Ты ВЕДЁШЬ диалог сам: здоровайся первым, задавай вопросы, предлагай темы (что радует, что тревожит,
как прошёл день, сон, отношения, работа). Не жди, что человек сам найдёт тему.
Если человек просит «начни», «расскажи», «я хочу тебя послушать» — не отказывайся и не переспрашивай:
начни говорить — мягко порассуждай вслух, задай вопрос, предложи выбор.
Отвечай коротко (1–3 предложения), по-человечески, без списков.
Если ниже есть «Память о человеке» — учитывай её естественно: не пересказывай списком,
не начинай с «я помню», просто обращайся так, как просил человек, и учитывай его обстоятельства.
"""

app = FastAPI(title="ryadom cognee PoC stub")
# rest — свой Cognee в twc-sber500 через port-forward (по умолчанию); mcp — старый путь через mcp.fantomas404.ru
COGNEE_MODE = os.environ.get("COGNEE_MODE", "rest")
cognee = CogneeMCP() if COGNEE_MODE == "mcp" else CogneeREST()
dialogs: dict[str, list[dict[str, str]]] = defaultdict(list)
brief_cache: dict[str, str] = {}  # сводка памяти по юзеру; сбрасывается в /dialog/end
_proxy_key: str | None = None


def dataset_of(user_id: str) -> str:
    safe = "".join(ch if ch.isalnum() else "_" for ch in user_id)
    return f"ryadom_stub_{safe}"


def proxy_key() -> str:
    """Ключ shared-прокси из agent-secrets в кластере (для whisper STT). В env процесса, не печатается."""
    global _proxy_key
    if _proxy_key is None:
        result = subprocess.run(
            ["kubectl", f"--kubeconfig={KUBECONFIG}", "-n", "agent", "get", "secret",
             "agent-secrets", "-o", "jsonpath={.data.AGENT_API_TOKEN}"],
            capture_output=True, check=True,
        )
        _proxy_key = base64.b64decode(result.stdout).decode()
    return _proxy_key


_gemini: dict[str, str] | None = None


def gemini_creds() -> dict[str, str]:
    """GEMINI_API_KEY / GEMINI_BASE_URL / GEMINI_RELAY_TOKEN из секрета agent-gemini (релей до Google)."""
    global _gemini
    if _gemini is None:
        result = subprocess.run(
            ["kubectl", f"--kubeconfig={KUBECONFIG}", "-n", "agent", "get", "secret",
             "agent-gemini", "-o", "json"],
            capture_output=True, check=True,
        )
        data = json.loads(result.stdout)["data"]
        _gemini = {k: base64.b64decode(v).decode() for k, v in data.items()}
    return _gemini


LIVE_MODEL = "gemini-3.8-live"  # как в проде (GEMINI_LIVE_MODEL default)
LIVE_VOICE = "Puck"


@app.websocket("/live/{user_id}")
async def live_ws(websocket: WebSocket, user_id: str) -> None:
    """Речь-в-речь через Gemini Live: PCM16 16kHz от браузера → Gemini → PCM16 24kHz в браузер.

    Память Cognee подмешивается в system_instruction; транскрипции хода пишутся в буфер диалога —
    /dialog/end сохраняет разговор в Cognee так же, как текстовый.
    """
    from google import genai
    from google.genai import types as t

    await websocket.accept()
    brief = await memory_brief(user_id)
    instructions = SYSTEM + (f"\n\nПамять о человеке:\n{brief}" if brief else "")
    creds = gemini_creds()
    client = genai.Client(
        api_key=creds["GEMINI_API_KEY"],
        http_options=t.HttpOptions(
            base_url=creds["GEMINI_BASE_URL"],
            headers={"X-Relay-Token": creds["GEMINI_RELAY_TOKEN"]},
        ),
    )
    config = t.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=instructions,
        input_audio_transcription=t.AudioTranscriptionConfig(),
        output_audio_transcription=t.AudioTranscriptionConfig(),
        speech_config=t.SpeechConfig(
            voice_config=t.VoiceConfig(prebuilt_voice_config=t.PrebuiltVoiceConfig(voice_name=LIVE_VOICE))
        ),
        # Браузер явно сообщает границы реплики, как в основном агенте: автоматический VAD Gemini не используется.
        realtime_input_config=t.RealtimeInputConfig(
            automatic_activity_detection=t.AutomaticActivityDetection(disabled=True)
        ),
    )
    heard: list[str] = []
    said: list[str] = []

    def flush_turn() -> None:
        if heard:
            dialogs[user_id].append({"role": "user", "content": " ".join(heard)})
            heard.clear()
        if said:
            dialogs[user_id].append({"role": "assistant", "content": " ".join(said)})
            said.clear()

    async def to_gemini(session) -> None:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                await session.send_realtime_input(
                    audio=t.Blob(data=message["bytes"], mime_type="audio/pcm;rate=16000")
                )
            elif message.get("text") is not None:
                frame = json.loads(message["text"])
                kind = frame.get("type")
                if kind == "audio_start":
                    await session.send_realtime_input(activity_start=t.ActivityStart())
                elif kind == "audio_end":
                    await session.send_realtime_input(activity_end=t.ActivityEnd())
                elif kind == "stop":
                    break

    async def from_gemini(session) -> None:
        # google-genai: итератор session.receive() ЗАВЕРШАЕТСЯ на конце каждого хода —
        # без внешнего цикла сессия «зависает» после первого вопроса-ответа.
        while True:
            async for response in session.receive():
                content = response.server_content
                if content is None:
                    continue
                if content.model_turn:
                    for part in content.model_turn.parts:
                        if part.inline_data and part.inline_data.data:
                            await websocket.send_bytes(part.inline_data.data)
                if content.input_transcription and content.input_transcription.text:
                    heard.append(content.input_transcription.text)
                    await websocket.send_text(json.dumps({"type": "you", "text": content.input_transcription.text}, ensure_ascii=False))
                if content.output_transcription and content.output_transcription.text:
                    said.append(content.output_transcription.text)
                    await websocket.send_text(json.dumps({"type": "agent", "text": content.output_transcription.text}, ensure_ascii=False))
                if content.turn_complete:
                    flush_turn()
                    await websocket.send_text(json.dumps({"type": "turn_end"}))

    try:
        async with client.aio.live.connect(model=LIVE_MODEL, config=config) as session:
            await websocket.send_text(json.dumps({"type": "ready", "model": LIVE_MODEL}))
            sender = asyncio.create_task(to_gemini(session))
            receiver = asyncio.create_task(from_gemini(session))
            done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                if task.exception():
                    raise task.exception()
    except WebSocketDisconnect:
        pass
    except Exception as error:
        try:
            await websocket.send_text(json.dumps({"type": "error", "text": str(error)[:300]}))
        except Exception:
            pass
    finally:
        flush_turn()
        brief_cache.pop(user_id, None)  # после live-разговора сводку перечитать
        await client.aio.aclose()


async def memory_brief(user_id: str) -> str:
    """Сводка памяти: тянется из Cognee один раз на диалог, дальше из кэша процесса (как brief.py в агенте)."""
    cached = brief_cache.get(user_id)
    if cached is not None:
        return cached
    try:
        text = await asyncio.wait_for(
            cognee.recall("Все факты об этом человеке: имя, как обращаться, город, работа, семья, интересы, что помогает", dataset_of(user_id)),
            timeout=45,  # GRAPH_COMPLETION через REST на своём деплое — 10-20 с, 12 с не хватало
        )
        if text.lstrip().startswith("Error:"):  # датасета ещё нет (404) и т.п. — значит, памяти нет
            text = ""
    except Exception:
        text = ""
    brief_cache[user_id] = text
    return text


async def ask_llm(user_id: str, text: str) -> dict:
    """Общий ход диалога: кэшированная сводка из Cognee + ответ GigaChat."""
    started = time.monotonic()
    memory_text = await memory_brief(user_id)
    memory_error = None
    system = SYSTEM
    if memory_text.strip() and "Error" not in memory_text[:20]:
        system += f"\n\nПамять о человеке:\n{memory_text.strip()}"
    messages = [{"role": "system", "content": system}]
    messages.extend(dialogs[user_id][-10:])
    messages.append({"role": "user", "content": text})
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            GPT2GIGA_URL,
            json={"model": MODEL, "messages": messages, "max_tokens": 300, "temperature": 0.7},
        )
        response.raise_for_status()
        reply = response.json()["choices"][0]["message"]["content"]
    dialogs[user_id].append({"role": "user", "content": text})
    dialogs[user_id].append({"role": "assistant", "content": reply})
    return {
        "reply": reply,
        "memory_used": memory_text.strip() or None,
        "memory_error": memory_error,
        "elapsed_s": round(time.monotonic() - started, 1),
    }


async def transcribe(audio: bytes, filename: str) -> str:
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            f"{PROXY_URL}/audio/transcriptions",
            headers={"Authorization": f"Bearer {proxy_key()}"},
            files={"file": (filename, audio)},
            data={"model": "whisper-large-v3", "language": "ru"},
        )
        response.raise_for_status()
        return response.json()["text"]


async def synthesize(text: str) -> str:
    """Озвучка через macOS say → m4a base64 для <audio> в браузере."""
    def _run() -> str:
        with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as tmp:
            aiff = tmp.name
        m4a = aiff.removesuffix(".aiff") + ".m4a"
        subprocess.run(["say", "-v", "Milena", "-o", aiff, text], check=True)
        subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", aiff, m4a], check=True)
        data = base64.b64encode(Path(m4a).read_bytes()).decode()
        Path(aiff).unlink(missing_ok=True)
        Path(m4a).unlink(missing_ok=True)
        return data

    return await asyncio.to_thread(_run)


class ChatIn(BaseModel):
    user_id: str
    text: str


class UserIn(BaseModel):
    user_id: str


@app.on_event("startup")
async def startup() -> None:
    await cognee.connect()


@app.on_event("shutdown")
async def shutdown() -> None:
    await cognee.aclose()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "llm": f"gpt2giga:{MODEL}", "memory": f"cognee via {COGNEE_MODE}", "stt": "whisper(proxy)", "tts": "say:Milena"}


@app.post("/chat")
async def chat(body: ChatIn) -> dict:
    return await ask_llm(body.user_id, body.text)


@app.post("/voice")
async def voice(user_id: str = Form(), file: UploadFile = File()) -> dict:
    audio = await file.read()
    transcript = await transcribe(audio, file.filename or "voice.webm")
    result = await ask_llm(user_id, transcript)
    result["transcript"] = transcript
    result["audio_m4a_base64"] = await synthesize(result["reply"])
    return result


@app.post("/dialog/end")
async def dialog_end(body: UserIn) -> dict:
    turns = dialogs.get(body.user_id, [])
    if not turns:
        return {"saved": False, "reason": "диалог пуст"}
    transcript = "\n".join(
        f"{'Человек' if t['role'] == 'user' else 'Агент'}: {t['content']}" for t in turns
    )
    started = time.monotonic()
    try:
        result = await cognee.remember(
            f"Транскрипт разговора человека с агентом поддержки:\n{transcript}", dataset_of(body.user_id)
        )
    except Exception as error:
        return {"saved": False, "reason": f"cognee недоступен, диалог НЕ потерян — нажми ещё раз: {error}"[:300]}
    if result.lstrip().startswith("Error:"):
        # серверный сбой: диалог остаётся в буфере, можно повторить
        return {"saved": False, "reason": f"cognee: {result[:200]} — диалог НЕ потерян, нажми ещё раз"}
    dialogs.pop(body.user_id, None)
    brief_cache.pop(body.user_id, None)  # следующая реплика подтянет свежий граф (cognify ~30–60 с)
    return {"saved": True, "turns": len(turns), "cognee": result[:300], "elapsed_s": round(time.monotonic() - started, 1)}


@app.get("/memory/{user_id}")
async def memory(user_id: str) -> dict:
    text = await cognee.recall("Что известно об этом человеке? Все факты.", dataset_of(user_id))
    return {"dataset": dataset_of(user_id), "memory": text}


PAGE = """<!doctype html><meta charset="utf-8"><title>ryadom voice PoC</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto">
<h2>Голосовая болванка: GigaChat + память Cognee</h2>
<label>user_id: <input id="uid" value="samofalov-voice"></label>
<button id="rec">🎙 Говорить</button>
<button id="live">⚡ Live (Gemini)</button>
<button id="end">Завершить диалог (→ Cognee)</button>
<button id="beep">🔊 Тест звука</button>
<audio id="player" controls style="display:block;margin:10px 0"></audio>
<div id="miclevel" style="font-family:monospace;color:#888">mic: —</div>
<pre id="log" style="white-space:pre-wrap;background:#f4f4f4;padding:12px"></pre>
<script>
let recorder, chunks = [];
const log = t => document.getElementById('log').textContent += t + "\\n";
document.getElementById('rec').onclick = async () => {
  if (recorder && recorder.state === 'recording') { recorder.stop(); document.getElementById('rec').textContent = '🎙 Говорить'; return; }
  const stream = await navigator.mediaDevices.getUserMedia({audio: true});
  chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = e => chunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    log('…распознаю…');
    const form = new FormData();
    form.append('user_id', document.getElementById('uid').value);
    form.append('file', new Blob(chunks, {type: 'audio/webm'}), 'voice.webm');
    const r = await fetch('/voice', {method: 'POST', body: form});
    const d = await r.json();
    log('ты: ' + d.transcript);
    log('агент: ' + d.reply);
    if (d.memory_used) log('  [память] ' + d.memory_used.slice(0, 300));
    const audio = document.getElementById('player');
    audio.src = 'data:audio/mp4;base64,' + d.audio_m4a_base64;
    audio.style.display = 'block';
    audio.play().catch(() => log('  (браузер заблокировал автоплей — нажми play под кнопками)'));
  };
  recorder.start();
  document.getElementById('rec').textContent = '⏹ Стоп';
};
document.getElementById('end').onclick = async () => {
  const r = await fetch('/dialog/end', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({user_id: document.getElementById('uid').value})});
  const d = await r.json();
  log('диалог сохранён в Cognee: ' + JSON.stringify(d));
};

// --- Live (Gemini): PCM16 16kHz вверх, PCM16 24kHz вниз ---
let liveWs, liveCtx, liveProc, liveStream, playCtx, playAt = 0, liveYou = '', liveAgent = '';
function toPcm16(buf, from, to) {
  // линейная интерполяция — наивная децимация давала алиасинг, Gemini слышал «испанский»
  if (from === to) {
    const same = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) same[i] = Math.max(-1, Math.min(1, buf[i])) * 32767;
    return same;
  }
  const ratio = from / to, out = new Int16Array(Math.floor(buf.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, lo = Math.floor(pos), hi = Math.min(lo + 1, buf.length - 1), frac = pos - lo;
    const s = buf[lo] + (buf[hi] - buf[lo]) * frac;
    out[i] = Math.max(-1, Math.min(1, s)) * 32767;
  }
  return out;
}
function playPcm(data) {
  // контекст на ДЕФОЛТНОЙ частоте устройства (Safari не умеет произвольный sampleRate),
  // буфер всегда 24kHz — браузер ресемплирует при воспроизведении
  try {
    if (!playCtx) playCtx = new AudioContext();
    if (playCtx.state !== 'running') {
      // контекст уснул (автоплей-политика/фон) — будим и сбрасываем расписание,
      // иначе часы currentTime стоят, playAt убегает вперёд и звука нет никогда
      log('live: audio context ' + playCtx.state + ' — будим');
      playCtx.resume();
      playAt = 0;
    }
    const pcm = new Int16Array(data);
    if (!pcm.length) return;
    const buf = playCtx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = playCtx.createBufferSource();
    src.buffer = buf; src.connect(playCtx.destination);
    // опережение НЕ ограничиваем: Gemini шлёт звук пачками быстрее реального времени,
    // сброс playAt вперёд накладывает чанки друг на друга (какафония). Чиним только отставание.
    if (playAt < playCtx.currentTime) playAt = playCtx.currentTime;
    src.start(playAt); playAt += buf.duration;
  } catch (err) {
    log('live: ОШИБКА плейбэка: ' + err.message);
  }
}
document.addEventListener('visibilitychange', () => {
  if (playCtx && !document.hidden && playCtx.state !== 'running') { playCtx.resume(); playAt = 0; }
});
document.getElementById('beep').onclick = async () => {
  // короткий бип через тот же плейбэк-контекст, что и голос агента — проверка тракта вывода
  if (!playCtx) playCtx = new AudioContext();
  await playCtx.resume();
  const osc = playCtx.createOscillator(), gain = playCtx.createGain();
  osc.frequency.value = 880; gain.gain.value = 0.2;
  osc.connect(gain); gain.connect(playCtx.destination);
  osc.start(); osc.stop(playCtx.currentTime + 0.3);
  playAt = 0;
  log('тест звука: бип 0.3с через AudioContext (state=' + playCtx.state + ') — если не слышно, проблема в выводе браузера, не в Gemini');
};
document.getElementById('live').onclick = async () => {
  const btn = document.getElementById('live');
  let audioActive = false, lastVoiceAt = 0;
  if (liveWs) {  // стоп
    liveWs.close(); liveWs = null;
    if (liveProc) liveProc.disconnect();
    if (liveStream) liveStream.getTracks().forEach(t => t.stop());
    btn.textContent = '⚡ Live (Gemini)';
    log('live: остановлено');
    return;
  }
  // AudioContext'ы создаём в жесте пользователя, иначе браузер держит их suspended и звука нет
  if (!playCtx) playCtx = new AudioContext();
  await playCtx.resume();
  try {
    liveCtx = new AudioContext({sampleRate: 16000});  // захват сразу 16kHz, без ресемплинга
  } catch (e) {
    liveCtx = new AudioContext();  // Safari: дефолтная частота, ресемплим сами интерполяцией
  }
  await liveCtx.resume();
  log('live: захват ' + liveCtx.sampleRate + 'Hz → 16000Hz');
  const uid = document.getElementById('uid').value;
  liveWs = new WebSocket(`ws://127.0.0.1:8090/live/${uid}`);
  liveWs.binaryType = 'arraybuffer';
  let audioChunks = 0;
  liveWs.onmessage = e => {
    if (typeof e.data !== 'string') {
      audioChunks++;
      if (audioChunks === 1) log('live: пошёл звук от агента');
      playPcm(e.data);
      return;
    }
    const m = JSON.parse(e.data);
    if (m.type === 'ready') log('live: сессия ' + m.model + ' открыта, говори');
    else if (m.type === 'you') { liveYou += m.text; }
    else if (m.type === 'agent') { liveAgent += m.text; }
    else if (m.type === 'turn_end') {
      if (liveYou) log('ты: ' + liveYou);
      if (liveAgent) log('агент: ' + liveAgent);
      liveYou = ''; liveAgent = '';
    }
    else if (m.type === 'error') log('live error: ' + m.text);
  };
  liveWs.onclose = () => { audioActive = false; if (liveWs) { liveWs = null; btn.textContent = '⚡ Live (Gemini)'; log('live: соединение закрыто'); } };
  liveStream = await navigator.mediaDevices.getUserMedia({audio: {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
  const src = liveCtx.createMediaStreamSource(liveStream);
  liveProc = liveCtx.createScriptProcessor(4096, 1, 1);
  // VAD с гистерезисом и подтверждением речи: короткий шум реплику не открывает, начало фразы сохраняется в pre-roll.
  const GAIN = 20;
  const MIN_START_RMS = 0.001;
  const MIN_STOP_RMS = 0.0005;
  const MIN_SPEECH_MS = 400;
  const PREROLL_FRAMES = 3;
  const END_OF_SPEECH_MS = 1800;
  let noiseFloor = 0.0001, speechLevel = 0, voiceCandidateSince = 0, preRoll = [];
  let levelEl = document.getElementById('miclevel');
  liveProc.onaudioprocess = e => {
    const ch = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    const speaking = playCtx && playCtx.currentTime < playAt - 0.05;
    const startThreshold = Math.max(MIN_START_RMS, noiseFloor * 5, speechLevel * 0.25);
    const stopThreshold = Math.min(startThreshold, Math.max(MIN_STOP_RMS, noiseFloor * 3, speechLevel * 0.12));
    const threshold = audioActive ? stopThreshold : startThreshold;
    const boosted = Math.min(1, rms * GAIN);
    levelEl.textContent = 'mic: ' + '█'.repeat(Math.min(30, Math.round(boosted * 60))) + ' '
      + rms.toFixed(4) + '→' + boosted.toFixed(3)
      + ' | фон ' + noiseFloor.toFixed(4) + ' / порог ' + threshold.toFixed(4)
      + (rms < 0.00005 ? ' | ⚠️ нет сигнала' : '')
      + (speaking ? ' | 🔇 агент говорит, mic выкл' : (audioActive ? ' | 🎤 реплика идёт' : (voiceCandidateSince ? ' | 🎤 проверяю речь' : ' | 🎤 слушаю')));
    if (!liveWs || liveWs.readyState !== 1) return;
    // half-duplex: пока агент говорит, микрофон не шлём — иначе Gemini слышит своё эхо из колонок
    if (speaking) return;
    const now = performance.now();
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = Math.max(-1, Math.min(1, ch[i] * GAIN));
    const pcm = toPcm16(out, liveCtx.sampleRate, 16000);
    if (!audioActive) {
      preRoll.push(pcm);
      if (preRoll.length > PREROLL_FRAMES) preRoll.shift();
      if (rms >= startThreshold) {
        if (!voiceCandidateSince) voiceCandidateSince = now;
        if (now - voiceCandidateSince >= MIN_SPEECH_MS) {
          audioActive = true;
          voiceCandidateSince = 0;
          speechLevel = speechLevel ? speechLevel * 0.9 + rms * 0.1 : rms;
          lastVoiceAt = now;
          liveWs.send(JSON.stringify({type: 'audio_start'}));
          for (const frame of preRoll) liveWs.send(frame);
          preRoll = [];
        }
      } else {
        voiceCandidateSince = 0;
        noiseFloor = noiseFloor * 0.95 + rms * 0.05;
      }
      return;
    }
    voiceCandidateSince = 0;
    preRoll = [];
    const voiced = rms >= stopThreshold;
    if (rms >= startThreshold) speechLevel = speechLevel * 0.9 + rms * 0.1;
    if (voiced) lastVoiceAt = now;
    liveWs.send(pcm);
    if (!voiced && now - lastVoiceAt >= END_OF_SPEECH_MS) {
      audioActive = false;
      liveWs.send(JSON.stringify({type: 'audio_end'}));
    }
  };
  src.connect(liveProc); liveProc.connect(liveCtx.destination);
  btn.textContent = '⏹ Live стоп';
};
</script>"""


@app.get("/", response_class=HTMLResponse)
async def page() -> str:
    return PAGE


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8090, log_level="warning")
