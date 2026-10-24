"""Время в том же виде, что `now_iso()` у диалогов: строки сравниваются как время."""

from datetime import UTC, datetime


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
