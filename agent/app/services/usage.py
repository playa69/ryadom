"""Расход моделей: сколько каждая модель получила и выдала на каждом вызове.

Клиент модели (app/clients/*) зовёт `record` сразу после ответа провайдера: так считается всё, за что провайдер берёт деньги,
в том числе прогрев озвучки и ответы, которые человек так и не увидел. `record` всегда увеличивает счётчик Prometheus
(`agent_model_usage_total`, без id), а если вызов идёт внутри диалога, ещё и отдаёт строку «приёмнику» диалога: сессия
решает, на какое сообщение её записать (таблица `model_usage` базы диалогов). Если включён Langfuse
(`app.services.langfuse_usage`), та же строка уходит и туда — без текста реплики.

Приёмник диалога передаётся через contextvar: клиенты моделей общие для всех диалогов и о диалоге не знают, а задачи
asyncio, созданные внутри `collect`/`sink_to`, наследуют его сами (синтез озвучки идёт в отдельных задачах).
"""

import functools
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import aclosing, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Protocol

from app.core.metrics import COMPONENT_CALLS_TOTAL, MODEL_USAGE_TOTAL

logger = logging.getLogger("agent.usage")


@dataclass(frozen=True, slots=True)
class Usage:
    """Один кусок расхода: модель, задача (live | phrase | stt | chat | tts), input/output, модальность, единица, количество."""

    model: str
    task: str
    direction: str
    modality: str
    unit: str
    amount: float


Sink = Callable[[Usage], None]
CallSink = Callable[[str, str, bool], None]  # компонент, исход, из памяти


class LangfuseEmit(Protocol):
    def emit(self, item: Usage) -> None: ...


_sink: ContextVar[Sink | None] = ContextVar("usage_sink", default=None)
_call_sink: ContextVar[CallSink | None] = ContextVar("component_call_sink", default=None)
_langfuse: LangfuseEmit | None = None


def install_langfuse(sink: LangfuseEmit | None) -> None:
    """Общий приёмник на процесс. Зовёт старт приложения; в тестах подменяется напрямую."""
    global _langfuse
    _langfuse = sink


def record(model: str, task: str, direction: str, modality: str, unit: str, amount: float) -> None:
    if amount <= 0:
        return
    MODEL_USAGE_TOTAL.labels(model, task, direction, modality, unit).inc(amount)
    dialog_sink = _sink.get()
    langfuse = _langfuse
    if dialog_sink is None and langfuse is None:
        return
    item = Usage(model, task, direction, modality, unit, amount)
    if dialog_sink is not None:
        dialog_sink(item)
    if langfuse is not None:
        try:
            langfuse.emit(item)
        except Exception:
            logger.exception("langfuse usage emit failed")


def call(component: str, outcome: str = "ok", cached: bool = False) -> None:
    """Одно реальное обращение к компоненту агента. Счётчик Prometheus растёт всегда; если оно идёт внутри диалога,
    сессия получает его и сообщает шлюзу кадром `component`: название, исход, «из памяти», больше ничего (ни промпта, ни
    текста, ни ошибки провайдера). Прогрев озвучки при старте идёт вне диалога и остаётся только в счётчике."""
    COMPONENT_CALLS_TOTAL.labels(component, outcome, "true" if cached else "false").inc()
    sink = _call_sink.get()
    if sink is None:
        return
    try:
        sink(component, outcome, cached)
    except Exception:
        logger.exception("component call report failed")


def bind_calls(sink: CallSink) -> None:
    """Обращения текущей задачи asyncio (и задач, которые она создаст дальше) уходят в `sink`. Звать в начале сокета диалога."""
    _call_sink.set(sink)


@contextmanager
def called(component: str, cached: bool = False) -> Iterator[None]:
    """Обращение засчитывается, когда блок закончился: `ok`, а если он упал с исключением, то `error`. Отмена задачи (не
    `Exception`) исход не портит: вызов состоялся и оплачен."""
    outcome = "ok"
    try:
        yield
    except Exception:
        outcome = "error"
        raise
    finally:
        call(component, outcome, cached)


def counted(component: str) -> Callable[[Callable[..., Awaitable[object]]], Callable[..., Awaitable[object]]]:
    """Декоратор для `async def`, который делает одно обращение к компоненту."""

    def wrap(function: Callable[..., Awaitable[object]]) -> Callable[..., Awaitable[object]]:
        @functools.wraps(function)
        async def inner(*args: object, **kwargs: object) -> object:
            with called(component):
                return await function(*args, **kwargs)

        return inner

    return wrap


def counted_stream(component: str) -> Callable[[Callable[..., AsyncIterator[object]]], Callable[..., AsyncIterator[object]]]:
    """То же для асинхронного генератора. Обращение считается, когда поток закончился или его закрыли."""

    def wrap(function: Callable[..., AsyncIterator[object]]) -> Callable[..., AsyncIterator[object]]:
        @functools.wraps(function)
        async def inner(*args: object, **kwargs: object) -> AsyncIterator[object]:
            with called(component):
                # aclosing: закрытие обёртки сразу закрывает и внутренний генератор, его `finally` не ждёт сборщика.
                async with aclosing(function(*args, **kwargs)) as pieces:  # type: ignore[type-var]
                    async for piece in pieces:
                        yield piece

        return inner

    return wrap


def bind(sink: Sink) -> None:
    """Весь расход текущей задачи asyncio (и задач, которые она создаст дальше) уходит в `sink`. Звать только в начале
    собственной задачи: контекст у задачи свой, и на того, кто её создал, это не влияет."""
    _sink.set(sink)


@contextmanager
def sink_to(sink: Sink) -> Iterator[None]:
    """Расход вызовов внутри блока (и задач, созданных в нём) уходит в `sink`."""
    token = _sink.set(sink)
    try:
        yield
    finally:
        _sink.reset(token)


@contextmanager
def collect() -> Iterator[list[Usage]]:
    """Собрать расход вызовов внутри блока в список: когда сообщение, к которому он относится, появится позже вызова."""
    spent: list[Usage] = []
    with sink_to(spent.append):
        yield spent
