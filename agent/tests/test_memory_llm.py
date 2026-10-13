"""Клиент модели извлечения (MEM-7.7): форма запроса, ошибки без текста ответа (I4), отказ от зарубежных адресов (B2)."""

import json

import httpx
import pytest

from app.core.config import LlmSettings
from app.memory.llm import MemoryLlm, MemoryModelError, build_memory_llm
from tests.memory_support import memory_settings

SECRET_ANSWER = "Сестра Аня лечится"  # «ответ модели»: не должен попасть в текст ошибки


def client(handler) -> httpx.AsyncClient:  # noqa: ANN001
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_request_shape_and_answer() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append({"url": str(request.url), "auth": request.headers["authorization"], "body": json.loads(request.content)})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"ops": []}'}}]})

    model = MemoryLlm("https://proxy.example/v1/", "key", "model-x", 1200, 60, client(handler))
    assert await model.complete([{"role": "user", "content": "привет"}]) == '{"ops": []}'
    [call] = seen
    assert call["url"] == "https://proxy.example/v1/chat/completions" and call["auth"] == "Bearer key"
    assert call["body"]["temperature"] == 0 and call["body"]["max_tokens"] == 1200 and call["body"]["model"] == "model-x"
    assert "response_format" not in call["body"]  # не все модели прокси его понимают


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(500, text=SECRET_ANSWER), "model"),
        (httpx.Response(200, text=SECRET_ANSWER), "model"),
        (httpx.Response(200, json={"choices": []}), "model"),
    ],
)
async def test_errors_never_carry_the_answer(response: httpx.Response, code: str) -> None:
    model = MemoryLlm("https://proxy.example/v1", "key", "m", 100, 60, client(lambda _: response))
    with pytest.raises(MemoryModelError) as error:
        await model.complete([{"role": "user", "content": "x"}])
    assert error.value.code == code and SECRET_ANSWER not in str(error.value)


async def test_timeout_has_its_own_code() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("медленно", request=request)

    model = MemoryLlm("https://proxy.example/v1", "key", "m", 100, 60, client(handler))
    with pytest.raises(MemoryModelError) as error:
        await model.complete([{"role": "user", "content": "x"}])
    assert error.value.code == "timeout"


def test_build_needs_an_address_and_a_key_and_refuses_gemini() -> None:
    llm = LlmSettings(LLM_BASE_URL="https://proxy.example/v1", AGENT_API_TOKEN="key")
    assert build_memory_llm(memory_settings(), llm) is not None
    assert build_memory_llm(memory_settings(), LlmSettings(LLM_BASE_URL="https://proxy.example/v1")) is None
    gemini = memory_settings(MEMORY_LLM_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai")
    assert build_memory_llm(gemini, llm) is None
    named = build_memory_llm(memory_settings(MEMORY_LLM_MODEL="small-model"), llm)
    assert named is not None and named.name == "proxy:small-model"
