"""Юнит-тесты логирования (задача 1.3): контекст из ContextVars, маскирование."""

from datetime import datetime
from zoneinfo import ZoneInfo

from app.logger.context_vars import CONTEXT_VARS_CONTAINER
from app.logger.logger import LoguruPatcher
from app.logger.masking import mask_email, mask_pii_in_text
from app.logger.models import dataclass_as_json_str


def _make_record(message: str, extra: dict | None = None) -> dict:
    return {
        "time": datetime(2026, 10, 3, 12, 0, 0),
        "level": type("Lvl", (), {"name": "INFO"})(),
        "name": "test.module",
        "function": "test_fn",
        "message": message,
        "extra": extra or {},
    }


def test_patcher_enriches_record_with_context():
    CONTEXT_VARS_CONTAINER.set_context_vars(
        x_trace_id="trace-123",
        x_request_time="2026-10-03T11:59:59",
        x_client_id="ios-app",
        x_aigw_session_id="sess-1",
        x_user_id="user-1",
    )
    patcher = LoguruPatcher(CONTEXT_VARS_CONTAINER, ZoneInfo("Europe/Moscow"))
    record = _make_record("hello")
    patcher.patching(record)
    assert '"rqUId": "trace-123"' in record["extra"]["serialized"]
    assert '"systemId": "ios-app"' in record["extra"]["serialized"]
    assert '"gwSessionId": "sess-1"' in record["extra"]["serialized"]
    CONTEXT_VARS_CONTAINER.set_context_vars()


def test_patcher_does_not_generate_rquid():
    CONTEXT_VARS_CONTAINER.set_context_vars()
    patcher = LoguruPatcher(CONTEXT_VARS_CONTAINER, ZoneInfo("Europe/Moscow"))
    record = _make_record("no trace")
    patcher.patching(record)
    # Сервис НЕ генерирует rqUId: поле остаётся пустым (null), а не auto-<uuid>
    assert '"rqUId": null' in record["extra"]["serialized"]
    assert "auto-" not in record["extra"]["serialized"]


def test_patcher_masks_email_in_message():
    CONTEXT_VARS_CONTAINER.set_context_vars()
    patcher = LoguruPatcher(CONTEXT_VARS_CONTAINER, ZoneInfo("Europe/Moscow"), mask_enabled=True)
    record = _make_record("Письмо отправлено на ivan.petrov@example.com")
    patcher.patching(record)
    assert "ivan.petrov@example.com" not in record["extra"]["serialized"]


def test_patcher_metric_and_audit_targets():
    CONTEXT_VARS_CONTAINER.set_context_vars(x_trace_id="trace-9")
    patcher = LoguruPatcher(CONTEXT_VARS_CONTAINER, ZoneInfo("Europe/Moscow"))
    metric_record = _make_record("", {"target": "metric", "metric_name": "m1", "metric_value": 5})
    patcher.patching(metric_record)
    assert '"metric_name": "m1"' in metric_record["extra"]["serialized"]

    audit_record = _make_record("", {"target": "audit-event", "audit_event_name": "TestEvent", "audit_params": {"a": 1}})
    patcher.patching(audit_record)
    assert '"name": "TestEvent"' in audit_record["extra"]["serialized"]
    CONTEXT_VARS_CONTAINER.set_context_vars()


def test_mask_email():
    masked = mask_email("ivan.petrov@example.com")
    assert "ivan.petrov" not in masked
    assert "example.com" not in masked
    assert "@" in masked
    assert "*" in masked


def test_mask_pii_in_text():
    masked = mask_pii_in_text("user maria@host.ru logged in")
    assert "maria@host.ru" not in masked


def test_dataclass_as_json_str_escapes():
    from app.logger.models import Metric

    assert dataclass_as_json_str(Metric(rqUId="x", metric_name="m", metric_value=1)) == (
        '{"rqUId": "x", "metric_name": "m", "metric_value": 1}'
    )
