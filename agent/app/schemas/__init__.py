"""Pydantic-схемы REST-контракта сервиса agent."""

from app.schemas.dialogs import (
    DialogDetail,
    DialogListItem,
    DialogListResponse,
    DialogSummary,
    EndDialogRequest,
    EndDialogResponse,
    MessageSchema,
    StartDialogResponse,
)

__all__ = [
    "DialogDetail",
    "DialogListItem",
    "DialogListResponse",
    "DialogSummary",
    "EndDialogRequest",
    "EndDialogResponse",
    "MessageSchema",
    "StartDialogResponse",
]
