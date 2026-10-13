"""Трейсинг LLM-ходов в self-hosted Langfuse (настройки — `LangfuseSettings` в app/core/config.py).

Один trace — один ход диалога (реплика человека → ответ агента); ходы одного разговора собираются
в сессию Langfuse по `session_id` (id диалога). Ход живёт через несколько задач asyncio (очередь
событий модели, озвучка), поэтому жизненный цикл наблюдений ручной: `update` по мере данных, `end`
в конце — контекстные менеджеры SDK здесь не ложатся.

По умолчанию выключен (`NullTracer`): без `LANGFUSE_ENABLED` агент работает ровно как раньше.
Трейсинг никогда не влияет на диалог: сбой записи — warning в журнал, а не исключение наружу.
Тексты реплик уходят только при `LANGFUSE_TRACE_TEXT=true`, иначе вместо них — длины; Langfuse
self-hosted в том же RU-кластере, где уже лежат сами диалоги (SQLite на томе пода).
"""

import asyncio
import logging
from typing import Any, Protocol

from app.core.config import LangfuseSettings

logger = logging.getLogger("agent.tracing")


def _mask(value: Any, trace_text: bool) -> Any:
    """Тексты реплик при выключенном `trace_text` заменяются их длиной; всё остальное проходит как есть."""
    if trace_text or value is None:
        return value
    if isinstance(value, str):
        return f"[скрыто, {len(value)} симв.]"
    if isinstance(value, list):  # сообщения чата: [{"role": ..., "content": ...}]
        return [
            {"role": m.get("role"), "content": _mask(str(m.get("content") or ""), False)} if isinstance(m, dict) else m
            for m in value
        ]
    return value


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
            kwargs["metadata"] = metadata
        if level is not None:
            kwargs["level"] = level
        if status is not None:
            kwargs["status_message"] = status
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
                name=name, model=model, input=_mask(input, self._trace_text), metadata=metadata
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
                name=name, model=model, input=_mask(input, self._trace_text), metadata=metadata
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
            span = parent.raw.start_span(name=name, input=_mask(input, self._trace_text), metadata=metadata)
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
    return LangfuseTracer(settings)
