"""Клиент OpenAI-совместимого API Cloud.ru: chat completions и транскрибация whisper."""

from openai import AsyncOpenAI


class CloudRuLLMClient:
    """Тонкая асинхронная обёртка над OpenAI-совместимым API Cloud.ru.

    Args:
        base_url: Базовый URL API (например, https://foundation-models.api.cloud.ru/v1).
        api_key: Bearer-ключ доступа (LLM_API_KEY).
        timeout_seconds: Таймаут HTTP-запросов в секундах.
    """

    def __init__(self, base_url: str, api_key: str, timeout_seconds: int) -> None:
        self._client = AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=timeout_seconds)

    async def complete(self, messages: list[dict[str, str]], model: str, *, max_tokens: int = 800) -> str:
        """Возвращает текст ответа модели на историю сообщений.

        Args:
            messages: История диалога в формате OpenAI (role/content).
            model: Имя chat-модели.
            max_tokens: Лимит токенов ответа.

        Returns:
            Текст ответа ассистента.
        """
        response = await self._client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
        )
        return response.choices[0].message.content or ""

    async def transcribe(self, audio: bytes, *, filename: str = "audio.wav", model: str) -> str:
        """Транскрибирует аудио через whisper.

        Args:
            audio: Готовые байты аудиофайла (wav).
            filename: Имя файла для multipart-запроса.
            model: Имя whisper-модели.

        Returns:
            Распознанный текст.
        """
        transcript = await self._client.audio.transcriptions.create(
            model=model,
            file=(filename, audio),
        )
        return transcript.text

    async def aclose(self) -> None:
        """Закрывает HTTP-клиент."""
        await self._client.close()
