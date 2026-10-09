"""Pydantic-модели REST-контракта сервиса agent.

Поля объявлены snake_case, на проводе — camelCase (alias_generator),
как в app/dev/agent-mock/server.mjs.
"""

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Базовая модель: сериализация и валидация по camelCase-алиасам."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class DialogSummary(CamelModel):
    """Сводка завершённого диалога для журнала."""

    title: str
    themes: list[str] = Field(default_factory=list)
    tension_before: int | None = None
    tension_after: int | None = None


class MessageSchema(CamelModel):
    """Сообщение диалога (role — user или assistant)."""

    id: str
    role: str
    text: str
    created_at: str


class DialogListItem(CamelModel):
    """Элемент журнала диалогов."""

    dialog_id: str
    started_at: str
    ended_at: str | None = None
    summary: DialogSummary | None = None


class DialogDetail(DialogListItem):
    """Диалог с сообщениями в порядке создания."""

    messages: list[MessageSchema] = Field(default_factory=list)


class StartDialogResponse(CamelModel):
    """Ответ на POST /v1/users/{userId}/dialogs."""

    dialog_id: str
    resumed: bool
    greeting: str
    since_last_dialog_hours: int | None = None


class DialogListResponse(CamelModel):
    """Страница журнала диалогов: от новых к старым."""

    items: list[DialogListItem]
    next: str | None = None


class EndDialogRequest(CamelModel):
    """Тело POST /v1/users/{userId}/dialogs/{dialogId}/end."""

    takeaway: str | None = None
    tension_after: int | None = Field(default=None, ge=1, le=10)


class EndDialogResponse(CamelModel):
    """Ответ на завершение диалога."""

    summary: DialogSummary | None = None
