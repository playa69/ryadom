"""Трейсинг LLM-ходов в self-hosted Langfuse (настройки — `LangfuseSettings` в app/core/config.py).

Один trace — один ход диалога (реплика человека → ответ агента); ходы одного разговора собираются
в сессию Langfuse по `session_id` (id диалога). Ход живёт через несколько задач asyncio (очередь
событий модели, озвучка), поэтому жизненный цикл наблюдений ручной: `update` по мере данных, `end`
в конце — контекстные менеджеры SDK здесь не ложатся.

По умолчанию выключен (`NullTracer`): без `LANGFUSE_ENABLED` агент работает ровно как раньше.
Трейсинг никогда не влияет на диалог: сбой записи — warning в журнал, а не исключение наружу.
Тексты реплик по умолчанию в Langfuse НЕ уходят (`LANGFUSE_TRACE_TEXT=false`): вместо них число символов и слов,
длительность речи, токены и задержки этапов. `LANGFUSE_TRACE_TEXT=true` только для локальной отладки: в проде тексты
реплик людей в трейсинг отправлять нельзя.
"""

import asyncio
import logging
from typing import Any, Protocol

from app.core.config import LangfuseSettings

logger = logging.getLogger("agent.tracing")


def _mask(value: Any, trace_text: bool) -> Any:
    """Тексты реплик при выключенном `trace_text` заменяются числом символов и слов. Незнакомые типы тоже скрываются."""
    if trace_text or value is None:
        return value
    if isinstance(value, str):
        return f"[скрыто: {len(value)} симв., {len(value.split())} сл.]"
    if isinstance(value, list):  # сообщения чата: [{"role": ..., "content": ...}]
        return [
            {"role": m.get("role"), "content": _mask(str(m.get("content") or ""), False)} if isinstance(m, dict) else "[скрыто]"
            for m in value
        ]
    return "[скрыто]"


MAX_PLAIN_METADATA_CHARS = 64


def _mask_status(status: str | None, trace_text: bool) -> str | None:
    """Статус ошибки. Тело ответа провайдера после двоеточия может нести кусок реплики, поэтому без текстов оно отбрасывается."""
    if trace_text or not status:
        return status
    return status.split(":", 1)[0][:80]


def _mask_metadata(metadata: dict[str, Any] | None, trace_text: bool) -> dict[str, Any] | None:
    """Метаданные — числа, флаги и короткие имена без пробелов (модель, голос, причина). Строка с пробелами или длиннее
    MAX_PLAIN_METADATA_CHARS скорее всего чей-то текст, её не отправляем."""
    if trace_text or metadata is None:
        return metadata
    return {
        key: "[скрыто]" if isinstance(value, str) and (len(value) > MAX_PLAIN_METADATA_CHARS or len(value.split()) > 1) else value
        for key, value in metadata.items()
    }


def _usage_details(usage: dict[str, Any] | None) -> dict[str, int] | None:
    """Расход токенов в формат Langfuse: только целые значения (usage_details принимает dict[str, int])."""
    if not usage:
        return None
    return {key: value for key, value in usage.items() if isinstance(value, int) and not isinstance(value, bool)}


class Observation(Protocol):
    """Одна наблюдаемая операция трассы: ход (generation), распознавание, озвучка (span)."""

    def update(
        self,
        *,
        input: Any = None,
        output: Any = None,
        usage: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        level: str | None = None,
        status: str | None = None,
    ) -> None: ...

    def end(self) -> None: ...


class NullObservation:
    """Пустышка: то же интерфейс, ничего не делает. Используется и как отсутствующий родитель."""

    def update(self, **kwargs: Any) -> None:
        return None

    def end(self) -> None:
        return None


NULL_OBSERVATION = NullObservation()


class Tracer(Protocol):
    """Источник наблюдений. `parent=None` у дочерних методов — сирота без трассы: наблюдение пропускается."""

    name: str

    def start_turn(
        self,
        *,
        name: str,
        session_id: str,
        user_id: str | None,
        model: str | None = None,
        input: Any = None,
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> Observation: ...

    def start_generation(
        self,
        parent: Observation | None,
        *,
        name: str,
        model: str | None = None,
        input: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> Observation: ...

    def start_span(
        self,
        parent: Observation | None,
        *,
        name: str,
        input: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> Observation: ...

    async def aclose(self) -> None:
        """Дождаться отправки накопленного (flush). Вызывается при остановке приложения."""
        ...


class NullTracer:
    """Трейсинг выключен: все вызовы — пустышки."""

    name = "null"

    def start_turn(self, **kwargs: Any) -> Observation:
        return NULL_OBSERVATION

    def start_generation(self, parent: Observation | None, **kwargs: Any) -> Observation:
        return NULL_OBSERVATION

    def start_span(self, parent: Observation | None, **kwargs: Any) -> Observation:
        return NULL_OBSERVATION

    async def aclose(self) -> None:
        return None


class LangfuseObservation:
    """Наблюдение Langfuse с ручным жизненным циклом и маскированием текстов.

    `update` после `end` молча игнорируется: события хода могут прийти позже его закрытия
    (расход токенов, хвост прерванного ответа), и это не повод для ошибки.
    """

    def __init__(self, span: Any, trace_text: bool) -> None:  # noqa: ANN401 — span: LangfuseSpan | LangfuseGeneration
        self.raw = span
        self._trace_text = trace_text
        self._ended = False

    @property
    def ended(self) -> bool:
        return self._ended

    def update(
        self,
        *,
        input: Any = None,
        output: Any = None,
        usage: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        level: str | None = None,
        status: str | None = None,
    ) -> None:
        if self._ended:
            return
        kwargs: dict[str, Any] = {}
        if input is not None:
            kwargs["input"] = _mask(input, self._trace_text)
        if output is not None:
            kwargs["output"] = _mask(output, self._trace_text)
        details = _usage_details(usage)
        if details:
            kwargs["usage_details"] = details
        if metadata is not None:
            kwargs["metadata"] = _mask_metadata(metadata, self._trace_text)
        if level is not None:
            kwargs["level"] = level
        if status is not None:
            kwargs["status_message"] = _mask_status(status, self._trace_text)
        if not kwargs:
            return
        try:
            self._span_update(kwargs)
        except Exception as error:  # noqa: BLE001
            logger.warning("langfuse update failed: %s", error)

    def _span_update(self, kwargs: dict[str, Any]) -> None:
        self.raw.update(**kwargs)

    def end(self) -> None:
        if self._ended:
            return
        self._ended = True
        try:
            self.raw.end()
        except Exception as error:  # noqa: BLE001
            logger.debug("langfuse end failed: %s", error)


class LangfuseTracer:
    """Langfuse Python SDK v3 (OTel): отправка идёт фоном и не блокирует диалог."""

    def __init__(self, settings: LangfuseSettings) -> None:
        from langfuse import Langfuse

        if settings.public_key is None or settings.secret_key is None:
            # До этого не дойдёт: LangfuseSettings валидирует то же самое на старте (fail-fast).
            raise RuntimeError("LANGFUSE_ENABLED=true, но не заданы LANGFUSE_PUBLIC_KEY и LANGFUSE_SECRET_KEY")
        self._client = Langfuse(
            public_key=settings.public_key.get_secret_value(),
            secret_key=settings.secret_key.get_secret_value(),
            host=settings.host,
        )
        self._trace_text = settings.trace_text
        self.name = f"langfuse:{settings.host}"

    def start_turn(
        self,
        *,
        name: str,
        session_id: str,
        user_id: str | None,
        model: str | None = None,
        input: Any = None,
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> Observation:
        """Корень трассы хода: generation с привязкой к сессии диалога и человеку."""
        try:
            generation = self._client.start_generation(
                name=name, model=model, input=_mask(input, self._trace_text), metadata=_mask_metadata(metadata, self._trace_text)
            )
            generation.update_trace(session_id=session_id, user_id=user_id, tags=tags)
            return LangfuseObservation(generation, self._trace_text)
        except Exception as error:  # noqa: BLE001
            logger.warning("langfuse trace start failed: %s", error)
            return NULL_OBSERVATION

    def start_generation(
        self,
        parent: Observation | None,
        *,
        name: str,
        model: str | None = None,
        input: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> Observation:
        if not isinstance(parent, LangfuseObservation):
            return NULL_OBSERVATION
        if parent.ended:
            # Озвучка может дописываться после закрытия трассы хода: такой ребёнок не создаётся.
            logger.debug("langfuse child %s skipped: parent trace already ended", name)
            return NULL_OBSERVATION
        try:
            generation = parent.raw.start_generation(
                name=name, model=model, input=_mask(input, self._trace_text), metadata=_mask_metadata(metadata, self._trace_text)
            )
            return LangfuseObservation(generation, self._trace_text)
        except Exception as error:  # noqa: BLE001
            logger.warning("langfuse generation start failed: %s", error)
            return NULL_OBSERVATION

    def start_span(
        self,
        parent: Observation | None,
        *,
        name: str,
        input: Any = None,
        metadata: dict[str, Any] | None = None,
    ) -> Observation:
        if not isinstance(parent, LangfuseObservation):
            return NULL_OBSERVATION
        if parent.ended:
            logger.debug("langfuse child %s skipped: parent trace already ended", name)
            return NULL_OBSERVATION
        try:
            span = parent.raw.start_span(
                name=name, input=_mask(input, self._trace_text), metadata=_mask_metadata(metadata, self._trace_text)
            )
            return LangfuseObservation(span, self._trace_text)
        except Exception as error:  # noqa: BLE001
            logger.warning("langfuse span start failed: %s", error)
            return NULL_OBSERVATION

    async def aclose(self) -> None:
        try:
            await asyncio.to_thread(self._client.flush)
        except Exception as error:  # noqa: BLE001
            logger.warning("langfuse flush failed: %s", error)


def build_tracer(settings: LangfuseSettings) -> Tracer:
    """Tracer по настройкам: выключен — NullTracer, включен — LangfuseTracer."""
    if not settings.enabled:
        return NullTracer()
    if settings.trace_text:
        logger.warning("LANGFUSE_TRACE_TEXT=true: тексты реплик людей и агента уходят в Langfuse (только для локальной отладки)")
    return LangfuseTracer(settings)
