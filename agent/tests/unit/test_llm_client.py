"""Юнит-тесты CloudRuLLMClient с подменённым AsyncOpenAI."""

from unittest.mock import AsyncMock, MagicMock, patch

from app.clients.llm import CloudRuLLMClient


def _make_client() -> tuple[CloudRuLLMClient, MagicMock, MagicMock]:
    """Собирает клиент с замоканным конструктором AsyncOpenAI."""
    with patch("app.clients.llm.AsyncOpenAI") as factory:
        sdk = MagicMock()
        factory.return_value = sdk
        client = CloudRuLLMClient(base_url="http://llm.local/v1", api_key="key", timeout_seconds=5)
    return client, sdk, factory


async def test_constructor_passes_settings_to_sdk() -> None:
    """Конструктор пробрасывает base_url, api_key и timeout в AsyncOpenAI."""
    _, _, factory = _make_client()
    factory.assert_called_once_with(
        base_url="http://llm.local/v1", api_key="key", timeout=5
    )


async def test_complete_returns_assistant_text() -> None:
    """complete возвращает content первого choice и шлёт модель с историей."""
    client, sdk, _ = _make_client()
    sdk.chat.completions.create = AsyncMock(
        return_value=MagicMock(choices=[MagicMock(message=MagicMock(content="Ответ"))])
    )
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "Привет"}]
    result = await client.complete(messages, "chat-model", max_tokens=100)
    assert result == "Ответ"
    sdk.chat.completions.create.assert_awaited_once_with(
        model="chat-model", messages=messages, max_tokens=100
    )


async def test_complete_empty_content_becomes_empty_string() -> None:
    """content=None приводится к пустой строке."""
    client, sdk, _ = _make_client()
    sdk.chat.completions.create = AsyncMock(
        return_value=MagicMock(choices=[MagicMock(message=MagicMock(content=None))])
    )
    assert await client.complete([], "chat-model") == ""


async def test_transcribe_sends_file_and_model() -> None:
    """transcribe отдаёт текст и передаёт wav-файл с именем модели."""
    client, sdk, _ = _make_client()
    sdk.audio.transcriptions.create = AsyncMock(return_value=MagicMock(text="расшифровка"))
    result = await client.transcribe(b"RIFF....", filename="audio.wav", model="openai/whisper-large-v3")
    assert result == "расшифровка"
    sdk.audio.transcriptions.create.assert_awaited_once_with(
        model="openai/whisper-large-v3", file=("audio.wav", b"RIFF....")
    )


async def test_aclose_closes_sdk_client() -> None:
    """aclose закрывает нижележащий HTTP-клиент."""
    client, sdk, _ = _make_client()
    sdk.close = AsyncMock()
    await client.aclose()
    sdk.close.assert_awaited_once()
