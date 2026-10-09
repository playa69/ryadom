"""Ноды графа диалогового хода."""

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage

from app.clients.llm import CloudRuLLMClient
from app.graph.prompts import SYSTEM_PROMPT
from app.graph.state import DialogState


def _to_api_message(message: BaseMessage) -> dict[str, str] | None:
    """Переводит сообщение LangChain в формат OpenAI API (system опускается)."""
    if isinstance(message, HumanMessage):
        return {"role": "user", "content": str(message.content)}
    if isinstance(message, AIMessage):
        return {"role": "assistant", "content": str(message.content)}
    return None


async def call_llm(state: DialogState, *, llm: CloudRuLLMClient, model: str) -> dict:
    """Вызывает LLM с системным промптом и историей диалога из состояния.

    Args:
        state: Текущее состояние графа с историей сообщений.
        llm: Клиент LLM Cloud.ru.
        model: Имя chat-модели.

    Returns:
        Дельта состояния с ответом ассистента.
    """
    history = [m for m in (_to_api_message(msg) for msg in state["messages"]) if m is not None]
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]
    reply = await llm.complete(messages, model)
    return {"messages": [AIMessage(content=reply)]}
