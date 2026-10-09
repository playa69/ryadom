"""Состояние графа диалога."""

from typing import Annotated, TypedDict

from langgraph.graph.message import add_messages


class DialogState(TypedDict):
    """История сообщений диалога.

    Редьюсер add_messages дописывает новые сообщения к накопленной
    в чекпоинте истории (thread_id = dialog_id).
    """

    messages: Annotated[list, add_messages]
