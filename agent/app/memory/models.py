"""Данные памяти: факт, настройки человека, задание извлечения, операция модели, сводка (MEM-5)."""

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any


def iso(moment: datetime) -> str:
    """Время в том же виде, что `now_iso()` у диалогов: строки сравниваются как время."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def days(count: float) -> timedelta:
    return timedelta(days=count)


FACT_COLUMNS = (
    "id",
    "user_id",
    "category",
    "text",
    "slots",
    "importance",
    "confidence",
    "status",
    "origin",
    "sensitivity",
    "supersedes_id",
    "norm_hash",
    "confirm_count",
    "seen_by_user",
    "created_at",
    "updated_at",
    "last_confirmed_at",
    "expires_at",
    "purge_after",
)


@dataclass
class Fact:
    id: str
    user_id: str
    category: str
    text: str
    slots: dict[str, str] | None
    importance: int
    confidence: float
    status: str
    origin: str
    sensitivity: str
    supersedes_id: str | None
    norm_hash: str
    confirm_count: int
    seen_by_user: bool
    created_at: str
    updated_at: str
    last_confirmed_at: str | None
    expires_at: str | None
    purge_after: str | None

    @classmethod
    def from_row(cls, row: tuple[Any, ...]) -> "Fact":
        values = dict(zip(FACT_COLUMNS, row, strict=True))
        values["slots"] = json.loads(values["slots"]) if values["slots"] else None
        values["seen_by_user"] = bool(values["seen_by_user"])
        return cls(**values)

    def to_row(self) -> tuple[Any, ...]:
        values = {name: getattr(self, name) for name in FACT_COLUMNS}
        values["slots"] = json.dumps(self.slots, ensure_ascii=False, sort_keys=True) if self.slots else None
        values["seen_by_user"] = int(self.seen_by_user)
        return tuple(values[name] for name in FACT_COLUMNS)

    def to_json(self, sources: list[dict[str, str]]) -> dict[str, Any]:
        """Факт в API (MEM-5.2)."""
        return {
            "id": self.id,
            "category": self.category,
            "text": self.text,
            "slots": self.slots,
            "importance": self.importance,
            "confidence": round(self.confidence, 3),
            "status": self.status,
            "origin": self.origin,
            "sensitivity": self.sensitivity,
            "sources": sources,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "lastConfirmedAt": self.last_confirmed_at,
            "expiresAt": self.expires_at,
            "confirmCount": self.confirm_count,
            "seenByUser": self.seen_by_user,
        }


@dataclass
class UserMemorySettings:
    """Согласие и выключатель человека (`memory_settings`). Нет строки — память выключена (opt-in, решение B1)."""

    user_id: str
    enabled: bool = False
    consent_version: str | None = None
    consent_at: str | None = None
    epoch_at: str | None = None  # диалоги, начатые не позже этого момента, не извлекаются (I9)
    tone_hint_until: str | None = None
    updated_at: str | None = None


@dataclass
class Job:
    """Задание извлечения: один диалог — одно задание (I12). Текстов не хранит."""

    dialog_id: str
    user_id: str
    status: str
    skip_reason: str | None
    attempts: int
    run_after: str
    last_error_code: str | None
    created_at: str
    done_at: str | None


@dataclass
class Op:
    """Операция, предложенная моделью (или собранная из ручного ввода) и прошедшая проверки раздела 7.5."""

    op: str  # add | update | confirm | supersede
    category: str
    text: str
    slots: dict[str, str] | None = None
    importance: int = 3
    confidence: float = 0.0
    ref: str | None = None  # id существующего факта для update | confirm | supersede
    message_ids: list[str] = field(default_factory=list)  # реплики человека, на которые опирается факт
    explicit: bool = False  # опирается на явную просьбу «запомни…»
    sensitive: bool = False


@dataclass
class Brief:
    """Собранная сводка человека в кэше процесса. `text` пустой — блока в промпте нет."""

    text: str
    version: int
    built_at: datetime
    enabled: bool = False
