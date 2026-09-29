"""HTTP middleware для логирования запросов/ответов и пропагации контекста."""

import json
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from fastapi import Request, status
from starlette.concurrency import iterate_in_threadpool
from starlette.responses import Response

from aigw_service.config import APP_CONFIG
from aigw_service.context import APP_CTX
from aigw_service.logger.utils import format_body_meta
from modules.gigachat_ext.gigachat_retry import _select_model

NON_LOGGED_ENDPOINTS = (
    "/like",
    "/dislike",
    "/health",
    "/info",
    "/openapi.json",
    "/docs",
)

HEADERS_WHITE_LIST_TO_LOG = (
    "x-trace-id",
    "x-request-time",
    "x-client-id",
    "x-session-id",
    "x-user-id",
)


def _get_decoded_body(raw_body: bytes, message_type: str, logger) -> dict:
    """Декодирует тело запроса/ответа из bytes в dict."""
    decoded_body = {}
    if not raw_body:
        return decoded_body
    try:
        decoded_body = json.loads(raw_body.decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        logger.warning(f"{message_type} body is not json")
    return decoded_body


async def log_requests(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """Логирует запрос/ответ, прокидывает заголовки и метрики."""
    start_time = time.time()
    logger = APP_CTX.get_logger()
    request_path = request.url.path

    # Достаем заголовки запроса
    allowed_headers_to_log = ((k, request.headers.get(k)) for k in HEADERS_WHITE_LIST_TO_LOG)
    headers_to_log = {header_name: header_value for header_name, header_value in allowed_headers_to_log if header_value}

    # Fallback: generate trace-id and request-time if missing
    x_trace_id = headers_to_log.get("x-trace-id")
    if not x_trace_id:
        x_trace_id = f"auto-{uuid.uuid4()}"
        headers_to_log["x-trace-id"] = x_trace_id

    x_request_time = headers_to_log.get("x-request-time")
    if not x_request_time:
        x_request_time = datetime.now(APP_CTX.get_pytz_timezone()).isoformat()
        headers_to_log["x-request-time"] = x_request_time

    APP_CTX.get_context_vars_container().request_start_time_var.set(start_time)
    # Устанавливаем контекстные переменные
    APP_CTX.get_context_vars_container().set_context_vars(
        x_trace_id=x_trace_id,
        x_request_time=x_request_time,
        x_client_id=headers_to_log.get("x-client-id", ""),
        x_aigw_session_id=headers_to_log.get("x-session-id", ""),
        x_user_id=headers_to_log.get("x-user-id", ""),
    )

    # Выбираем GigaChat-модель один раз на весь запрос.
    selected_model = _select_model(APP_CONFIG.gigachat.gigachat_model_weights)
    APP_CTX.get_context_vars_container().set_gigachat_model(selected_model)

    # Выбираем embeddings-модель отдельно от LLM-модели.
    selected_embedding_model = _select_model(APP_CONFIG.gigachat.gigachat_embedding_model_weights)
    APP_CTX.get_context_vars_container().set_gigachat_embedding_model(selected_embedding_model)

    # Логируем получение запроса
    if request_path in NON_LOGGED_ENDPOINTS:  # Не следует логировать эти эндпоинты
        response = await call_next(request)
        logger.debug(f"Processed request for {request_path} with code {response.status_code}")
    # Проверка на наличие заголовка x-trace-id в запросе
    elif headers_to_log.get("x-trace-id", None):
        # Получаем тело запроса
        raw_request_body = await request.body()
        request_body_decoded = _get_decoded_body(raw_request_body, "request", logger)
        # Логируем, кидаем событие в аудит, кидаем метрику о количестве запросов
        logger.info(
            f"Incoming {request.method}-request for {request_path}",
            serviceType="Получен запрос от клиента",
            args={
                "headers": headers_to_log,
                "message": format_body_meta(request_body_decoded),
            },
            message_type="request",
            path=request_path,
        )
        client_id = headers_to_log.get("x-user-id", None)
        if client_id:
            logger.metric(
                metric_name=f"aigw_service_user_{client_id}",
                metric_value=1,
            )
        logger.metric(
            metric_name="aigw_service_requests_total",
            metric_value=1,
        )
        logger.audit(
            event_name="BusinessRequestReceived",
            event_params=json.dumps(
                request_body_decoded,
                ensure_ascii=False,
            ),
        )

        response = await call_next(request)

        # Тело response - это итератор, по которому нельзя пройти повторно.
        # Один из вариантов решения - это собрать итератор повторно, что и представлено ниже
        response_body = [chunk async for chunk in response.body_iterator]
        response.body_iterator = iterate_in_threadpool(iter(response_body))

        # Добавляем заголовки ответа
        headers_to_log["x-response-time"] = datetime.now(APP_CTX.get_pytz_timezone()).isoformat()
        for header in headers_to_log:
            response.headers[header] = headers_to_log[header]

        # Логируем ответ приложения и кидаем метрику количества ответов
        response_body_extracted = response_body[0] if len(response_body) > 0 else b""
        decoded_response_body = _get_decoded_body(response_body_extracted, "response", logger)
        logger.info(
            "Outgoing response to client system",
            serviceType="Отправлен ответ клиенту",
            args={
                "headers": headers_to_log,
                "message": format_body_meta(decoded_response_body),
            },
            message_type="response",
            path=request_path,
        )
        logger.metric(
            metric_name="aigw_service_responses_total",
            metric_value=1,
        )
        logger.audit(
            event_name="BusinessRequestFinished",
            event_params=json.dumps(
                decoded_response_body,
                ensure_ascii=False,
            ),
        )

        # Логируем время обработки запроса и кидаем метрику скорости ответа
        processing_time_ms = int(round(time.time() - start_time, 3) * 1000)
        logger.info(f"Request processing time for {request_path}: {processing_time_ms} ms")
        logger.metric(
            metric_name="aigw_service_process_duration_ms",
            metric_value=processing_time_ms,
        )

        # Кидаем метрику статуса обработки запроса
        if response.status_code < status.HTTP_400_BAD_REQUEST:
            logger.metric(
                metric_name="aigw_service_request_status_success_total",
                metric_value=1,
            )
        else:
            logger.metric(
                metric_name="aigw_service_request_status_failure_total",
                metric_value=1,
            )
    else:
        # Логируем получение запроса без x-trace-id и обрабатываем его
        logger.info(f"Incoming {request.method}-request with no id for {request_path}")
        response = await call_next(request)
        logger.info(f"Request with no id for {request_path} processing time: {time.time() - start_time: .3f} s")

    return response


__all__ = [
    "log_requests",
]
