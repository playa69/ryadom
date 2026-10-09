"""HTTP-клиенты моделей против поддельного прокси (httpx.MockTransport): запрос, разбор ответа, отказы."""

import io
import json
import wave

import httpx
import pytest

from app.clients.llm import ModelError, ProxyChat, ProxyWhisper, build_models
from app.core.config import LlmSettings

BASE = "https://proxy.test/v1"


def chat(handler) -> ProxyChat:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ProxyChat(BASE + "/", "secret-key", "chat-model", max_tokens=100, temperature=0.5, timeout_seconds=5, client=client)


def whisper(handler) -> ProxyWhisper:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ProxyWhisper(BASE, "secret-key", "stt-model", timeout_seconds=5, client=client)


def completion(content, finish_reason="stop") -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": finish_reason}]}


async def test_chat_sends_the_dialog_and_returns_the_trimmed_answer():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = request.read()
        return httpx.Response(200, json=completion("  Я рядом.  "))

    model = chat(handler)
    assert await model.complete([{"role": "user", "content": "привет"}]) == "Я рядом."
    assert seen["url"] == "https://proxy.test/v1/chat/completions"
    assert seen["auth"] == "Bearer secret-key"
    body = json.loads(seen["body"])
    assert body["model"] == "chat-model" and body["max_tokens"] == 100 and body["temperature"] == 0.5
    assert body["messages"] == [{"role": "user", "content": "привет"}]
    assert not body.get("stream")  # ответ короткий и нужен целиком


async def test_chat_cut_by_the_token_limit_keeps_whole_sentences():
    model = chat(lambda r: httpx.Response(200, json=completion("Первое. Второе. Третье обор", "length")))
    assert await model.complete([]) == "Первое. Второе."


async def test_chat_answer_without_content_is_empty_not_an_error():
    model = chat(lambda r: httpx.Response(200, json=completion(None)))
    assert await model.complete([]) == ""


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, text="boom"),
        httpx.Response(401, json={"error": "bad key"}),
        httpx.Response(200, text="не json"),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(200, json={"unexpected": True}),
    ],
)
async def test_chat_failures_become_model_errors(response):
    with pytest.raises(ModelError):
        await chat(lambda r: response).complete([])


async def test_chat_network_failure_becomes_a_model_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("нет связи", request=request)

    with pytest.raises(ModelError):
        await chat(handler).complete([])


async def test_whisper_sends_a_wav_with_the_right_form_and_returns_the_text():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["content_type"] = request.headers["content-type"]
        seen["body"] = request.read()
        return httpx.Response(200, json={"text": " Мне тяжело. "})

    pcm = b"\x10\x00" * 16_000  # секунда на 16 кГц
    assert await whisper(handler).transcribe(pcm) == "Мне тяжело."

    assert seen["url"] == "https://proxy.test/v1/audio/transcriptions"
    assert seen["auth"] == "Bearer secret-key"
    assert seen["content_type"].startswith("multipart/form-data")
    body = seen["body"]
    assert b'name="model"\r\n\r\nstt-model' in body
    assert b'name="language"\r\n\r\nru' in body
    # внутри файла настоящий WAV: PCM16, моно, 16 кГц
    start = body.index(b"RIFF")
    with wave.open(io.BytesIO(body[start : body.index(b"\r\n--", start)]), "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16_000)
        assert wav.getnframes() == 16_000


@pytest.mark.parametrize(
    "response",
    [httpx.Response(500, text="boom"), httpx.Response(200, text="не json"), httpx.Response(200, json={"words": []})],
)
async def test_whisper_failures_become_model_errors(response):
    with pytest.raises(ModelError):
        await whisper(lambda r: response).transcribe(b"\x00\x00" * 160)


def test_template_mode_builds_no_models():
    assert build_models(LlmSettings(LLM_MODE="template")) == (None, None)


def test_proxy_mode_needs_a_key_and_an_address():
    with pytest.raises(RuntimeError, match="AGENT_API_TOKEN"):
        build_models(LlmSettings(LLM_MODE="proxy", LLM_BASE_URL="https://proxy.test/v1"))
    with pytest.raises(RuntimeError, match="LLM_BASE_URL"):
        build_models(LlmSettings(LLM_MODE="proxy", AGENT_API_TOKEN="k"))


def test_proxy_mode_builds_both_models_with_the_configured_names():
    chat_model, recognizer = build_models(
        LlmSettings(LLM_MODE="proxy", LLM_BASE_URL="https://proxy.test/v1", AGENT_API_TOKEN="k")
    )
    assert chat_model.name == "proxy:gigachat3.5-432b-a28b"
    assert recognizer.name == "proxy:whisper-large-v3"
