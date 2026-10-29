"""Голосовой путь Сбера (app/clients/sber_voice.py) без сети: пересчёт звука, нарезка ответа GigaChat на куски для синтеза
(поддельный прокси, httpx.MockTransport), запасной путь соединения и озвучки фраз, классификатор тона на GigaChat."""

import asyncio
import json
import math
from array import array

import httpx
import pytest

from app.clients.gemini_live import LiveError
from app.clients.sber_voice import (
    CHAT_MODEL,
    FallbackConnector,
    FallbackTts,
    GigaChatMoodClassifier,
    SberVoiceLink,
    Upsampler,
    own_gender,
    realtime_url,
)
from app.clients.speech import TtsError
from app.services.replies import system_prompt


def tone(seconds: float, rate: int = 16_000) -> bytes:
    samples = array("h", (int(8000 * math.sin(2 * math.pi * 220 * i / rate)) for i in range(int(rate * seconds))))
    return samples.tobytes()


def samples(pcm: bytes) -> array:
    out = array("h")
    out.frombytes(pcm)
    return out


def test_upsampling_does_not_depend_on_the_frame_length() -> None:
    pcm = tone(1.0)
    whole = samples(Upsampler()(pcm))
    for frame in (640, 1280, 3200):  # 20, 40 и 100 мс
        up = Upsampler()
        pieces = samples(b"".join(up(pcm[at : at + frame]) for at in range(0, len(pcm), frame)))
        assert abs(len(pieces) - len(whole)) <= 1
        assert max(abs(a - b) for a, b in zip(pieces, whole, strict=False)) <= 2


def test_upsampling_gives_24_khz() -> None:
    out = samples(Upsampler()(tone(1.0)))
    assert abs(len(out) - 24_000) <= 2


def test_agent_speaks_of_itself_in_the_gender_of_the_voice_that_sounds() -> None:
    assert own_gender(system_prompt("male")) == system_prompt("female")  # голос SaluteSpeech женский
    assert own_gender(system_prompt("female")) == system_prompt("female")


def test_realtime_url_from_the_proxy_base() -> None:
    assert realtime_url("https://proxy.example:4000/v1/", "gigaasr") == "wss://proxy.example:4000/v1/realtime?model=gigaasr"


def sse(pieces: list[str], usage: dict | None = None) -> bytes:
    lines = [f"data: {json.dumps({'choices': [{'delta': {'content': piece}}]}, ensure_ascii=False)}" for piece in pieces]
    if usage is not None:
        lines.append(f"data: {json.dumps({'choices': [], 'usage': usage})}")
    lines.append("data: [DONE]")
    return ("\n\n".join(lines) + "\n\n").encode()


class _Connector:
    chat_url = "https://proxy.example/v1/chat/completions"

    def __init__(self, handler) -> None:  # noqa: ANN001
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def chunks_of(pieces: list[str], usage: dict | None = None) -> tuple[list[str], dict[str, int], dict]:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, content=sse(pieces, usage), headers={"content-type": "text/event-stream"})

    link = SberVoiceLink.__new__(SberVoiceLink)
    link._connector = _Connector(handler)  # type: ignore[assignment]
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    spent: dict[str, int] = {}
    await link._write([{"role": "user", "content": "привет"}], queue, spent)
    out: list[str] = []
    while (item := queue.get_nowait()) is not None:
        out.append(item)
    return out, spent, seen


async def test_answer_goes_to_speech_sentence_by_sentence_as_it_streams() -> None:
    pieces = ["Пони", "маю. Это пра", "вда непросто. ", "Что сейчас **тяжелее** всего?"]
    out, spent, request = await chunks_of(pieces, {"prompt_tokens": 120, "completion_tokens": 18})
    assert out == ["Понимаю.", "Это правда непросто.", "Что сейчас тяжелее всего?"]
    assert spent == {"input_text": 120, "output_text": 18}
    assert request["model"] == CHAT_MODEL and request["stream"] is True


async def test_long_first_sentence_is_cut_at_a_clause_so_the_voice_starts_sooner() -> None:
    text = "Когда всё валится из рук, а сил нет совсем и хочется просто лечь, это очень тяжело. Ты не один в этом, правда."
    out, _, _ = await chunks_of([text[i : i + 7] for i in range(0, len(text), 7)])
    assert out == [
        "Когда всё валится из рук, а сил нет совсем и хочется просто лечь,",
        "это очень тяжело.",
        "Ты не один в этом, правда.",  # дальше режется только по концу предложения
    ]


async def test_list_markers_and_line_breaks_are_not_spoken() -> None:
    out, _, _ = await chunks_of(["Попробуй так:\n\n- выключи уведомления.\n- Тёплый душ.\n1) Ляг пораньше"])
    assert out == ["Попробуй так: выключи уведомления.", "Тёплый душ.", "Ляг пораньше"]


async def test_chat_error_is_a_live_error_and_ends_the_stream() -> None:
    link = SberVoiceLink.__new__(SberVoiceLink)
    link._connector = _Connector(lambda request: httpx.Response(429, text="quota"))  # type: ignore[assignment]
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    with pytest.raises(LiveError):
        await link._write([], queue, {})
    assert queue.get_nowait() is None  # читатель кусков не повиснет


class _Link:
    closed = False

    def __init__(self, name: str) -> None:
        self.voice_name = name


class _Opener:
    def __init__(self, name: str, fail: bool = False) -> None:
        self.name = name
        self.model = f"{name}-model"
        self.fail = fail
        self.opened = 0

    async def open(self, voice, instructions, history=None):  # noqa: ANN001, ANN201
        self.opened += 1
        if self.fail:
            raise LiveError(f"{self.name} недоступен")
        return _Link(self.name)

    async def aclose(self) -> None:
        return None


async def test_fallback_connector_opens_gemini_when_sber_does_not_open() -> None:
    sber, gemini = _Opener("sber", fail=True), _Opener("gemini")
    link = await FallbackConnector(sber, gemini).open("male", "промпт")
    assert link.voice_name == "gemini" and sber.opened == 1 and gemini.opened == 1


async def test_fallback_connector_uses_sber_when_it_opens() -> None:
    sber, gemini = _Opener("sber"), _Opener("gemini")
    link = await FallbackConnector(sber, gemini).open("male", "промпт")
    assert link.voice_name == "sber" and gemini.opened == 0


class _Tts:
    def __init__(self, name: str, pieces: list[bytes] | None = None, fail_after: int | None = None) -> None:
        self.name = name
        self._pieces = pieces or []
        self._fail_after = fail_after

    async def stream(self, text: str, voice: str):  # noqa: ANN201
        for n, piece in enumerate(self._pieces):
            if self._fail_after is not None and n >= self._fail_after:
                raise TtsError("оборвалось")
            yield piece
        if self._fail_after is not None and self._fail_after >= len(self._pieces):
            raise TtsError("не ответил")

    async def synthesize(self, text: str, voice: str) -> bytes:
        return b"".join([piece async for piece in self.stream(text, voice)])

    async def aclose(self) -> None:
        return None


async def test_fallback_tts_speaks_with_gemini_when_salute_gives_no_sound() -> None:
    tts = FallbackTts(_Tts("salute", fail_after=0), _Tts("gemini", [b"\x01\x00"]))
    assert [piece async for piece in tts.stream("Привет.", "male")] == [b"\x01\x00"]
    assert await tts.synthesize("Привет.", "male") == b"\x01\x00"


async def test_fallback_tts_does_not_restart_a_phrase_that_already_sounds() -> None:
    tts = FallbackTts(_Tts("salute", [b"\x01\x00", b"\x02\x00"], fail_after=1), _Tts("gemini", [b"\x09\x00"]))
    heard: list[bytes] = []
    with pytest.raises(TtsError):
        async for piece in tts.stream("Привет.", "male"):
            heard.append(piece)
    assert heard == [b"\x01\x00"]  # половина фразы одним голосом и целая другим звучали бы дважды


async def test_gigachat_tone_classifier_reads_json_and_distrusts_the_model() -> None:
    answers = iter(['Вот ответ: {"tone": "sad", "intensity": 0.6}', '{"tone": "furious", "intensity": 1}'])
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        usage = {"prompt_tokens": 50, "completion_tokens": 9}
        return httpx.Response(200, json={"choices": [{"message": {"content": next(answers)}}], "usage": usage})

    classifier = GigaChatMoodClassifier(_Connector(handler))  # type: ignore[arg-type]
    assert await classifier.classify("мне грустно") == {"tone": "sad", "intensity": 0.6}
    assert seen[0]["model"] == CHAT_MODEL and seen[0]["messages"][-1] == {"role": "user", "content": "мне грустно"}
    assert await classifier.classify("ну и ладно") is None  # тона вне списка нет


async def test_gigachat_tone_classifier_gives_up_after_one_retry() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(500)

    assert await GigaChatMoodClassifier(_Connector(handler)).classify("мне страшно") is None  # type: ignore[arg-type]
    assert len(calls) == 2
