"""Сборка RequestTrace из лог-записей одного rqUId (слой 2 инспектора запросов).

Принимает записи, которые отдаёт ``aigw.logger.log_reader`` (список
``LogRecord`` с полями asctime/levelName/funcName/message), и интерпретирует
ТЕКСТОВЫЕ маркеры оркестратора в поле ``message``, собирая доменную модель
трейса. HTTP/FastAPI и схема ответа API сюда не тащатся — это чистый сборщик.

Архитектурные ограничения (осознанные):
- Модуль живёт в ``aigw`` и НЕ импортирует ничего из ``orchestrator`` и
  ``business``: значения ``kind`` и строковые маркеры дублируются локально как
  «дрейф маркеров», смягчаемый тестами. При изменении формата логов в
  ``src/orchestrator/orchestrator/graph_builder.py`` /
  ``src/a2a_integration/server/agent_executor.py`` регэкспы ниже нужно править.
- Маркерные регэкспы якорятся на ПРЕФИКС строки, поэтому поля, дописанные в конец,
  инспектору не мешают и намеренно не парсятся: у ``MCP:result`` это ``is_error`` и
  ``content_kind`` после ``response_text_len``. Новое поле добавляется только после
  уже разбираемых, а ``<magenta>``-дамп остаётся последним.
- Значения ``TraceKind`` обязаны совпадать с бизнес-контрактом ``DebugTrace``
  (src/modules/business/...) и с ``TRACE_KINDS`` в ``src/aigw/api/ui.py``
  (JS-рендер ключуется по этим 4 строкам). Совпадение критично, импорта нет.
"""

import re
from dataclasses import dataclass, field
from typing import Literal

from aigw.logger.log_reader import LogRecord

# Должно совпадать с DebugTrace (modules/business) и TRACE_KINDS (aigw/api/ui.py).
TraceKind = Literal["agent-request", "tool-request", "agent-response", "tool-response"]

KIND_AGENT_REQUEST: TraceKind = "agent-request"
KIND_TOOL_REQUEST: TraceKind = "tool-request"
KIND_AGENT_RESPONSE: TraceKind = "agent-response"
KIND_TOOL_RESPONSE: TraceKind = "tool-response"

StatusLiteral = Literal["completed", "failed", "unknown"]
DetailLevel = Literal["full", "skeleton"]


@dataclass
class TraceIds:
    """Идентификаторы прогона; лучший источник — маркер ``Graph params``."""

    context_id: str | None = None
    task_id: str | None = None


@dataclass
class Step:
    """Один шаг трейса. Запрос и ответ — РАЗНЫЕ шаги (по одному ``kind`` каждый),
    т.к. UI-рендер ключуется по ``kind`` из ``TRACE_KINDS``."""

    order: int
    kind: TraceKind
    name: str | None = None
    request: str | None = None
    response: str | None = None
    status: str | None = None


@dataclass
class RequestTrace:
    """Доменная модель собранного трейса одного rqUId."""

    rquid: str
    ids: TraceIds = field(default_factory=TraceIds)
    plan: list[str] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)
    final_response: str | None = None
    status: StatusLiteral = "unknown"
    detail_level: DetailLevel = "skeleton"
    warnings: list[str] = field(default_factory=list)


# --- Маркеры оркестратора (дрейф; форматы см. в docstring модуля) -------------

_RE_GRAPH_PARAMS = re.compile(r"Graph params: context_id=(?P<ctx>.*?), task_id=(?P<task>\S+) used_agents=")
_RE_EXECUTE_FAILED = re.compile(r"execute:failed context_id=\S+ task_id=\S+ error=")
_RE_PLANNER = re.compile(r"(?:Baseline)?Planner:result (?:plan_schema=(?P<schema>\S+) )?goto=\S+")
_RE_WORKER_TOOL = re.compile(r"Worker:result step=(?P<i>\d+)/(?P<n>\d+) tool_name=(?P<name>\S+) goto=\S+ request_keys=")
_RE_WORKER_AGENT = re.compile(r"Worker:(?P<mode>result|skip) step=(?P<i>\d+)/(?P<n>\d+) agent_name=(?P<name>\S+) goto=")
_RE_A2A_RESULT = re.compile(r"A2A:result agent_name=(?P<name>\S+) status=(?P<status>\S+) goto=")
_RE_MCP_RESULT = re.compile(r"MCP:result tool_name=(?P<name>\S+) goto=\S+ response_text_len=")
_RE_RESPONDER = re.compile(r"Responder:result response_len=\d+ goto=")
_RE_SMALLTALK = re.compile(r"SmallTalk:result response_len=\d+ answer=(?P<answer>.*) goto=\S+", re.DOTALL)
_RE_A2A_DISPATCH_MESSAGES = re.compile(
    r"Выполняется A2A-запрос к (?P<name>[^.]+?)\." r"(?>.*?messages=)(?P<msg>.*?), headers=",
    re.DOTALL,
)

# --- Контентные дампы (в тех же INFO-строках, обёрнуты <magenta>...</magenta>) -
_RE_REQUEST_TO_TOOL = re.compile(r"Request to tool: (?P<payload>.*?)</magenta>", re.DOTALL)
_RE_RAW_DUMP = re.compile(r"Raw: (?P<raw>.*?)</magenta>", re.DOTALL)
_RE_RESPONSE_DUMP = re.compile(r"Response: (?P<resp>.*?)</magenta>", re.DOTALL)

_MAGENTA_TAGS = re.compile(r"</?magenta>")


def build_request_trace(
    rquid: str,
    records: list[LogRecord],
    reader_warnings: list[str] | None = None,
) -> RequestTrace:
    """Собирает :class:`RequestTrace` из записей одного rqUId.

    Args:
        rquid: идентификатор запроса (только для наполнения результата).
        records: записи в порядке появления в логе (из ``LogReadResult.records``).
        reader_warnings: warnings из ``LogReadResult`` — прокидываются в трейс.

    Returns:
        RequestTrace. Пустой ``records`` → пустой трейс с ``detail_level="skeleton"``
        и warning «нет записей по rqUId» (не падает). Строки без известного
        маркера молча игнорируются.
    """
    trace = RequestTrace(rquid=rquid)
    if reader_warnings:
        trace.warnings.extend(reader_warnings)

    if not records:
        trace.warnings.append(f"нет записей по rqUId {rquid}")
        return trace

    for record in records:
        _consume_record(record.message, trace)

    _finalize(trace)
    return trace


def _consume_record(message: str, trace: RequestTrace) -> None:
    """Обрабатывает одну лог-запись: пытается сопоставить маркеры по порядку."""
    if _try_graph_params(message, trace):
        return
    if _RE_EXECUTE_FAILED.search(message):
        trace.status = "failed"
        return
    if _try_planner(message, trace):
        return
    if _try_worker_tool(message, trace):
        return
    if _try_worker_agent(message, trace):
        return
    if _try_a2a_result(message, trace):
        return
    if _try_mcp_result(message, trace):
        return
    if _try_responder(message, trace):
        return
    if _try_smalltalk(message, trace):
        return
    _try_agent_request_payload(message, trace)


def _try_graph_params(message: str, trace: RequestTrace) -> bool:
    match = _RE_GRAPH_PARAMS.search(message)
    if not match:
        return False
    trace.ids.context_id = match.group("ctx")
    trace.ids.task_id = match.group("task")
    return True


def _try_planner(message: str, trace: RequestTrace) -> bool:
    match = _RE_PLANNER.search(message)
    if not match:
        return False
    schema = match.group("schema")
    if schema:
        trace.plan = [name for name in schema.split("->") if name]
    return True


def _try_worker_tool(message: str, trace: RequestTrace) -> bool:
    match = _RE_WORKER_TOOL.search(message)
    if not match:
        return False
    request = _extract(_RE_REQUEST_TO_TOOL, message, "payload")
    _add_step(trace, KIND_TOOL_REQUEST, name=match.group("name"), request=request)
    return True


def _try_worker_agent(message: str, trace: RequestTrace) -> bool:
    match = _RE_WORKER_AGENT.search(message)
    if not match:
        return False
    status = "skipped" if match.group("mode") == "skip" else None
    _add_step(trace, KIND_AGENT_REQUEST, name=match.group("name"), status=status)
    return True


def _try_a2a_result(message: str, trace: RequestTrace) -> bool:
    match = _RE_A2A_RESULT.search(message)
    if not match:
        return False
    response = _extract(_RE_RAW_DUMP, message, "raw")
    _add_step(
        trace,
        KIND_AGENT_RESPONSE,
        name=match.group("name"),
        response=response,
        status=match.group("status"),
    )
    return True


def _try_mcp_result(message: str, trace: RequestTrace) -> bool:
    match = _RE_MCP_RESULT.search(message)
    if not match:
        return False
    response = _extract(_RE_RAW_DUMP, message, "raw")
    _add_step(trace, KIND_TOOL_RESPONSE, name=match.group("name"), response=response)
    return True


def _try_responder(message: str, trace: RequestTrace) -> bool:
    if not _RE_RESPONDER.search(message):
        return False
    response = _extract(_RE_RESPONSE_DUMP, message, "resp")
    if response is not None:
        trace.final_response = response
    if trace.status != "failed":
        trace.status = "completed"
    return True


def _try_smalltalk(message: str, trace: RequestTrace) -> bool:
    match = _RE_SMALLTALK.search(message)
    if not match:
        return False
    answer = _strip_magenta(match.group("answer")).strip()
    trace.final_response = answer or None
    if trace.status != "failed":
        trace.status = "completed"
    return True


def _try_agent_request_payload(message: str, trace: RequestTrace) -> bool:
    """Тянет текст запроса к агенту из строки ``Выполняется A2A-запрос к ...``
    и привязывает к последнему agent-request-шагу без заполненного request."""
    match = _RE_A2A_DISPATCH_MESSAGES.search(message)
    if not match:
        return False
    name = match.group("name")
    payload = _strip_magenta(match.group("msg")).strip() or None
    for step in reversed(trace.steps):
        if step.kind == KIND_AGENT_REQUEST and step.request is None:
            if step.name == name or step.name is None:
                step.request = payload
                return True
    return True


def _add_step(
    trace: RequestTrace,
    kind: TraceKind,
    *,
    name: str | None = None,
    request: str | None = None,
    response: str | None = None,
    status: str | None = None,
) -> None:
    trace.steps.append(
        Step(
            order=len(trace.steps),
            kind=kind,
            name=name,
            request=request,
            response=response,
            status=status,
        )
    )


def _extract(pattern: re.Pattern[str], message: str, group: str) -> str | None:
    match = pattern.search(message)
    if not match:
        return None
    return _strip_magenta(match.group(group)).strip() or None


def _strip_magenta(text: str) -> str:
    return _MAGENTA_TAGS.sub("", text)


def _finalize(trace: RequestTrace) -> None:
    has_payload = trace.final_response is not None or any(
        step.request is not None or step.response is not None for step in trace.steps
    )
    trace.detail_level = "full" if has_payload else "skeleton"


__all__ = [
    "TraceKind",
    "TraceIds",
    "Step",
    "RequestTrace",
    "build_request_trace",
]
