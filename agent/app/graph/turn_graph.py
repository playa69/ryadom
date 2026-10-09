"""Граф одного диалогового хода с чекпоинтингом истории в Postgres."""

from functools import partial

from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from app.clients.llm import CloudRuLLMClient
from app.graph.nodes import call_llm
from app.graph.state import DialogState


def build_turn_graph(llm: CloudRuLLMClient, *, model: str, checkpointer) -> CompiledStateGraph:
    """Собирает граф хода: реплика пользователя → LLM → ответ ассистента.

    Args:
        llm: Клиент LLM Cloud.ru.
        model: Имя chat-модели.
        checkpointer: Чекпоинтер истории (AsyncPostgresSaver).

    Returns:
        Скомпилированный граф с подключённым чекпоинтером.
    """
    builder = StateGraph(DialogState)
    builder.add_node("llm", partial(call_llm, llm=llm, model=model))
    builder.add_edge(START, "llm")
    builder.add_edge("llm", END)
    return builder.compile(checkpointer=checkpointer)


async def run_turn(graph: CompiledStateGraph, *, user_id: str, dialog_id: str, text: str) -> str:
    """Выполняет диалоговый ход и возвращает текст ответа ассистента.

    История накапливается в чекпоинте по thread_id = dialog_id.
    checkpoint_ns пользователя остаётся в метаданных конфига; корневой граф
    LangGraph всегда пишет чекпоинты в пустой namespace — изоляцию истории
    между пользователями обеспечивает глобально уникальный thread_id.

    Args:
        graph: Скомпилированный граф из build_turn_graph.
        user_id: Идентификатор пользователя (namespace чекпоинта).
        dialog_id: Идентификатор диалога (thread чекпоинта).
        text: Текст реплики пользователя.

    Returns:
        Текст ответа ассистента.
    """
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content=text)]},
        config={"configurable": {"thread_id": dialog_id, "checkpoint_ns": user_id}},
    )
    return str(result["messages"][-1].content)
