"""Расход моделей: сколько каждая модель получила и выдала на каждом вызове.

Клиент модели (app/clients/*) зовёт `record` сразу после ответа провайдера: так считается всё, за что провайдер берёт деньги,
в том числе прогрев озвучки и ответы, которые человек так и не увидел. `record` всегда увеличивает счётчик Prometheus
(`agent_model_usage_total`, без id), а если вызов идёт внутри диалога, ещё и отдаёт строку «приёмнику» диалога: сессия
решает, на какое сообщение её записать (таблица `model_usage` базы диалогов).

Приёмник передаётся через contextvar: клиенты моделей общие для всех диалогов и о диалоге не знают, а задачи asyncio,
созданные внутри `collect`/`sink_to`, наследуют его сами (синтез озвучки идёт в отдельных задачах).
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from app.core.metrics import MODEL_USAGE_TOTAL


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

_sink: ContextVar[Sink | None] = ContextVar("usage_sink", default=None)


def record(model: str, task: str, direction: str, modality: str, unit: str, amount: float) -> None:
    if amount <= 0:
        return
    MODEL_USAGE_TOTAL.labels(model, task, direction, modality, unit).inc(amount)
    sink = _sink.get()
    if sink is not None:
        sink(Usage(model, task, direction, modality, unit, amount))


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
