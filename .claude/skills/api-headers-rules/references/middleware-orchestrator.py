import json
import time
from copy import deepcopy
from datetime import datetime

from fastapi import Request, status
from starlette.concurrency import iterate_in_threadpool
from starlette.responses import StreamingResponse

from aigw.context import APP_CTX

NON_LOGGED_ENDPOINTS = (
    "/like",
    "/dislike",
    "/health",
    "/info",
    "/openapi.json",
    "/docs",
    "/",
)

HEADERS_WHITE_LIST_TO_LOG = (
    "x-trace-id",
    "x-request-time",
    "x-client-id",
    "x-session-id",
    "x-user-id",
    "x-surface",
)


def _compact_json(obj: object) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)


def _one_line(text: str) -> str:
    return text.replace("\r", "\\r").replace("\n", "\\n").replace("\t", " ")


def _decode_body(raw_body: bytes, content_type: str | None) -> tuple[object, str, int]:
    """
    Full-body decode for logging. Returns: (body, kind, body_bytes).
      kind: empty | json | invalid_json | text
    """
    if not raw_body:
        return None, "empty", 0
    ct = (content_type or "").lower()
    body_bytes = len(raw_body)
    looks_like_json = raw_body.lstrip().startswith((b"{", b"["))
    is_json_ct = "json" in ct  # includes application/json and +json
    if is_json_ct or looks_like_json:
        try:
            return json.loads(raw_body.decode()), "json", body_bytes
        except (json.JSONDecodeError, UnicodeDecodeError):
            return (
                _one_line(raw_body.decode("utf-8", errors="replace")),
                "invalid_json",
                body_bytes,
            )
    return _one_line(raw_body.decode("utf-8", errors="replace")), "text", body_bytes


def _response_headers_for_message(response) -> dict[str, str]:
    # Keep it small and useful.
    result: dict[str, str] = {}
    for name in HEADERS_WHITE_LIST_TO_LOG:
        value = response.headers.get(name)
        if value:
            result[name] = value
    return result


def _mask_message_objects(payload: object, *, is_response: bool, mask_enabled: bool) -> object:
    """
    Masks human-readable content inside A2A/JSON-RPC message objects.

    - For any dict with kind="message":
      - masks part["text"] in parts
      - masks metadata entirely
    - For responses with result.kind="task": replaces history with "***" (to avoid huge logs)
    """
    if not isinstance(payload, (dict, list)):
        return payload

    masked = deepcopy(payload)

    def walk(node: object) -> None:
        if isinstance(node, dict):
            if node.get("kind") == "message":
                parts = node.get("parts")
                if isinstance(parts, list):
                    for part in parts:
                        if mask_enabled and isinstance(part, dict) and "text" in part:
                            part["text"] = "***"
                if "metadata" in node:
                    metadata = node.get("metadata")
                    if isinstance(metadata, dict):
                        node["metadata"] = {"_keys": sorted(metadata.keys())}
                    elif mask_enabled:
                        node["metadata"] = "***"
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    if is_response and isinstance(masked, dict):
        result = masked.get("result")
        if isinstance(result, dict) and result.get("kind") == "task" and "history" in result and mask_enabled:
            result["history"] = "***"

    walk(masked)
    return masked


async def log_requests(request: Request, call_next):
    start_time = time.time()
    logger = APP_CTX.logger
    request_path = request.url.path
    request_ct = request.headers.get("content-type")

    # Request headers (whitelist used for correlation + response headers propagation).
    allowed_headers_to_log = ((k, request.headers.get(k)) for k in HEADERS_WHITE_LIST_TO_LOG)
    headers_to_log = {header_name: header_value for header_name, header_value in allowed_headers_to_log if header_value}
    has_trace_id = bool(headers_to_log.get("x-trace-id"))

    # Context variables
    APP_CTX.context_vars_container.set_context_vars(
        x_trace_id=headers_to_log.get("x-trace-id", ""),
        x_request_time=headers_to_log.get("x-request-time", ""),
        x_client_id=headers_to_log.get("x-client-id", ""),
        x_session_id=headers_to_log.get("x-session-id", ""),
        x_user_id=headers_to_log.get("x-user-id", ""),
        request_start_time=start_time,
    )

    if request_path not in NON_LOGGED_ENDPOINTS:
        if not has_trace_id:
            logger.info(f"Incoming {request.method}-request with no id for {request_path}")
            response = await call_next(request)
            logger.info(f"Request with no id for {request_path} processing time: {time.time() - start_time: .3f} s")
            return response

        raw_request_body = await request.body()
        request_body, _kind, request_body_bytes = _decode_body(raw_body=raw_request_body, content_type=request_ct)
        request_body_masked = _mask_message_objects(request_body, is_response=False, mask_enabled=APP_CTX.mask_enabled)
        headers_msg = _compact_json(headers_to_log)
        body_msg = _compact_json(request_body_masked)
        logger.info(
            f"Incoming request: method={request.method} path={request_path} content_type={request_ct or 'unknown'} "
            f"headers={headers_msg} body_bytes={request_body_bytes} body={body_msg}"
        )
        # Use masked body for audit/metrics payloads (safer default).
        request_body_decoded = request_body_masked if isinstance(request_body_masked, dict) else {}
        client_id = headers_to_log.get("x-user-id", None)
        if client_id:
            logger.metric(metric_name=f"aigw_service_user_{client_id}", metric_value=1)
        logger.metric(metric_name="aigw_service_requests_total", metric_value=1)
        logger.audit(
            event_name="BusinessRequestReceived",
            event_params=json.dumps(request_body_decoded, ensure_ascii=False),
        )

    response = await call_next(request)

    if request_path in NON_LOGGED_ENDPOINTS:
        duration_ms = int(round(time.time() - start_time, 3) * 1000)
        # Probe endpoints (/health etc.) fire every few seconds: a 2xx/3xx probe
        # hit is kubelet noise, not a business event → DEBUG. Failures stay
        # visible at WARNING — they explain why a pod left rotation.
        log = logger.debug if response.status_code < 400 else logger.warning
        log(
            f"Outgoing response: method={request.method} path={request_path} status={response.status_code} duration_ms={duration_ms}"
        )
        return response

    # ✅ КРИТИЧНО: если это стрим (SSE) — НЕ ТРОГАЕМ body_iterator!
    content_type = (response.headers.get("content-type") or "").lower()
    is_sse = content_type.startswith("text/event-stream")
    is_streaming = isinstance(response, StreamingResponse)

    # Add response headers (as before).
    headers_to_log["x-response-time"] = datetime.now(APP_CTX.timezone).isoformat()
    for header, value in headers_to_log.items():
        response.headers[header] = value

    if is_sse or is_streaming:
        duration_ms = int(round(time.time() - start_time, 3) * 1000)
        headers_msg = _compact_json(_response_headers_for_message(response))
        logger.info(
            f"Outgoing response: method={request.method} path={request_path} status={response.status_code} "
            f"duration_ms={duration_ms} streaming=true headers={headers_msg} body=not_logged"
        )
        if request_path not in NON_LOGGED_ENDPOINTS and has_trace_id:
            logger.info(f"Request processing time for {request_path}: {duration_ms} ms")
            logger.metric(metric_name="aigw_service_responses_total", metric_value=1)
            logger.metric(metric_name="aigw_service_process_duration_ms", metric_value=duration_ms)
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
        return response

    # --- Non-streaming response: read full body, then restore body iterator ---
    response_chunks = [chunk async for chunk in response.body_iterator]
    raw_response_body = b"".join(response_chunks) if response_chunks else b""

    # Special-case: override JSON-RPC id to trace_id for /orchestrator responses.
    if request_path.endswith("/orchestrator") and raw_response_body:
        try:
            payload = json.loads(raw_response_body.decode("utf-8"))
            trace_id = headers_to_log.get("x-trace-id")
            if trace_id and isinstance(payload, dict):
                payload["id"] = trace_id
                new_raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                raw_response_body = new_raw
                response_chunks = [new_raw]
                response.headers["content-length"] = str(len(new_raw))
        except Exception as exc:
            logger.warning(f"Failed to override JSON-RPC id in response for path={request_path}: {exc}")

    response.body_iterator = iterate_in_threadpool(iter(response_chunks))

    response_ct = response.headers.get("content-type")
    response_body, _kind, response_body_bytes = _decode_body(raw_body=raw_response_body, content_type=response_ct)
    response_body_masked = _mask_message_objects(response_body, is_response=True, mask_enabled=APP_CTX.mask_enabled)
    duration_ms = int(round(time.time() - start_time, 3) * 1000)

    headers_msg = _compact_json(_response_headers_for_message(response))
    body_msg = _compact_json(response_body_masked)
    logger.info(
        f"Outgoing response: method={request.method} path={request_path} status={response.status_code} duration_ms={duration_ms} "
        f"content_type={response_ct or 'unknown'} headers={headers_msg} body_bytes={response_body_bytes} body={body_msg}"
    )

    # Metrics/Audit only for business endpoints (keep existing behavior).
    if request_path not in NON_LOGGED_ENDPOINTS:
        logger.info(f"Request processing time for {request_path}: {duration_ms} ms")
        logger.metric(metric_name="aigw_service_responses_total", metric_value=1)
        logger.audit(
            event_name="BusinessRequestFinished",
            event_params=json.dumps(
                response_body_masked if isinstance(response_body_masked, dict) else {},
                ensure_ascii=False,
            ),
        )
        logger.metric(metric_name="aigw_service_process_duration_ms", metric_value=duration_ms)

        if response.status_code < status.HTTP_400_BAD_REQUEST:
            logger.metric(metric_name="aigw_service_request_status_success_total", metric_value=1)
        else:
            logger.metric(metric_name="aigw_service_request_status_failure_total", metric_value=1)

    return response


__all__ = [
    "log_requests",
]
