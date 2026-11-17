"""REST-клиент к Cognee API — второй бэкенд памяти агента (`MEMORY_BACKEND=cognee`).

Наш Cognee (ns agent, twc-sber500) живёт только внутри кластера; локально клиент ходит через port-forward:

    kubectl -n agent port-forward svc/cognee 18000:8000

В деплое включён multi-user access control (ENABLE_BACKEND_ACCESS_CONTROL=true) — без него /search НЕ фильтрует
по датасетам. Поэтому клиент логинится сервисным пользователем (`COGNEE_SERVICE_EMAIL` / `COGNEE_SERVICE_PASSWORD`),
дальше все вызовы идут с Bearer; на 401 — перелогин и один повтор. Пароль нигде не печатается.

Память человека — его датасет: remember = add + cognify (документ уходит в граф), recall = search GRAPH_COMPLETION
по датасету. Ошибки HTTP в recall/read_consent читаются как «памяти нет» (пустая строка), а не как сбой разговора.

Каждый публичный логический вызов пишет одно TOOL-наблюдение в Langfuse (метрика `tool_requests`,
`openspec/changes/update-sber500-dashboard-metrics`): имя операции, user_id аккаунта, исход (успех/ERROR). Тексты
и содержимое памяти в наблюдение не попадают. Логин, чтение списка датасетов и повтор после 401 — служебные шаги
одного вызова, записей не создают. Сбой записи в Langfuse не влияет на вызов памяти (трейсинг сам гасит ошибки).
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from app.core.tracing import Observation, Tracer, current_tracer

logger = logging.getLogger("agent.memory")

# Поиск — в диалоговом контуре: повисшее соединение (обрыв сети до кластера) не должно висеть по 600 с,
# как cognify; лучше быстрый сбой и ответ без находки.
SEARCH_TIMEOUT = httpx.Timeout(90.0, connect=5.0)


class CogneeClient:
    def __init__(
        self,
        base_url: str,
        email: str,
        password: str,
        client: httpx.AsyncClient | None = None,
        tracer: Tracer | None = None,
    ) -> None:
        self._email = email
        self._password = password
        # Без явного трассировщика — общий экземпляр процесса: его строит lifespan до клиента памяти.
        self._tracer = tracer if tracer is not None else current_tracer()
        # cognify большого транскрипта — до нескольких минут LLM-ходов
        self._client = client or httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/api/v1",
            timeout=httpx.Timeout(600.0, connect=15.0),
        )

    async def connect(self) -> None:
        """Логин при старте: токен кладётся в заголовок Authorization общего клиента."""
        await self._login()

    async def _login(self) -> None:
        response = await self._client.post("/auth/login", data={"username": self._email, "password": self._password})
        response.raise_for_status()
        token = response.json()["access_token"]
        self._client.headers["Authorization"] = f"Bearer {token}"

    async def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Запрос с Bearer; протухший токен (401) — перелогин и один повтор."""
        response = await self._client.request(method, url, **kwargs)
        if response.status_code == 401:
            await self._login()
            response = await self._client.request(method, url, **kwargs)
        return response

    @asynccontextmanager
    async def _trace_tool(
        self, name: str, user_id: str | None, session_id: str | None, metadata: dict[str, Any] | None = None
    ) -> AsyncIterator[Observation]:
        """Одна TOOL-запись на логический вызов памяти. Успех — вызов выполнен: без исключения, без отмены, для поиска
        ещё и HTTP 200, для удалений — цель существовала (не-200 и «не нашлось» помечаются ERROR в самом методе).
        Исключение или отмена — запись с ERROR, дальше ошибка летит вызывающему как раньше."""
        observation = self._tracer.start_tool(name, user_id=user_id, session_id=session_id, metadata=metadata)
        try:
            yield observation
        except asyncio.CancelledError:
            # Отмена (остановка агента, закрытие сокета) — не успех: вызов не завершился. BaseException, ловим отдельно.
            observation.update(level="ERROR", status="cancelled")
            raise
        except Exception as error:
            # Текст исключения может нести url с именем датасета (в нём user_id): в трейс идёт только тип ошибки.
            observation.update(level="ERROR", status=type(error).__name__)
            raise
        finally:
            observation.end()

    async def add(self, text: str, dataset: str) -> None:
        """Сохраняет документ в датасете без построения графа."""
        response = await self._send(
            "POST",
            "/add",
            files={"data": ("transcript.txt", text.encode(), "text/plain")},
            data={"datasetName": dataset},
        )
        response.raise_for_status()

    async def cognify(self, dataset: str) -> None:
        """Строит граф по документам датасета."""
        response = await self._send("POST", "/cognify", json={"datasets": [dataset]})
        response.raise_for_status()

    async def remember(self, text: str, dataset: str, *, user_id: str | None = None, session_id: str | None = None) -> None:
        """Сохраняет документ и строит граф, как MCP-инструмент remember. add+cognify — один логический вызов записи."""
        async with self._trace_tool("memory_write", user_id, session_id):
            await self.add(text, dataset)
            await self.cognify(dataset)

    async def add_document(
        self, text: str, dataset: str, name: str, *, user_id: str | None = None, session_id: str | None = None
    ) -> str | None:
        """Один документ в датасет человека (по документу на разговор), затем cognify. Возвращает id документа в Cognee: по нему
        разговор удаляется жёстко (`delete_document`). `name` — имя файла, по нему документ находится, если id потерян."""
        async with self._trace_tool("memory_write", user_id, session_id):
            response = await self._send(
                "POST",
                "/add",
                files={"data": (f"{name}.txt", text.encode(), "text/plain")},
                data={"datasetName": dataset},
            )
            response.raise_for_status()
            data_id: str | None = None
            try:
                info = response.json().get("data_ingestion_info") or []
                if info and isinstance(info[0], dict) and info[0].get("data_id"):
                    data_id = str(info[0]["data_id"])
            except (ValueError, AttributeError):
                pass
            cognify = await self._send("POST", "/cognify", json={"datasets": [dataset]})
            cognify.raise_for_status()
            return data_id

    async def delete_document(
        self,
        dataset: str,
        data_id: str | None = None,
        name: str | None = None,
        *,
        user_id: str | None = None,
        session_id: str | None = None,
    ) -> bool:
        """Жёстко удалить один документ: Cognee убирает вместе с ним куски, эмбеддинги и узлы графа (проверено разовым спайком на Cognee 1.5.3).
        Нет ни датасета, ни документа — уже удалено (False). Документ ищется по `data_id`, иначе по `name`.
        False — вызов не выполнен: в TOOL-записи это ERROR `not_found`, чтобы метрика `tool_requests` его не считала."""
        async with self._trace_tool("memory_delete_document", user_id, session_id) as observation:
            dataset_id = await self._dataset_id(dataset)
            if dataset_id is None:
                observation.update(level="ERROR", status="not_found")
                return False
            if data_id is None and name is not None:
                listing = await self._send("GET", f"/datasets/{dataset_id}/data")
                listing.raise_for_status()
                for item in listing.json():
                    if isinstance(item, dict) and item.get("name") == name:
                        data_id = str(item.get("id"))
                        break
            if data_id is None:
                observation.update(level="ERROR", status="not_found")
                return False
            response = await self._send("DELETE", f"/datasets/{dataset_id}/data/{data_id}")
            if response.status_code == 404:
                observation.update(level="ERROR", status="not_found")
                return False
            response.raise_for_status()
            return True

    @staticmethod
    def _texts(payload: Any) -> list[str]:
        """Ответ /search — JSON-список; элементы-словари с полем search_result (список строк) распаковываются."""
        if not isinstance(payload, list):
            return [str(payload)] if payload else []
        parts: list[str] = []
        for item in payload:
            if isinstance(item, dict) and isinstance(item.get("search_result"), list):
                parts.extend(str(piece) for piece in item["search_result"])
            else:
                parts.append(str(item))
        return [part for part in parts if part]

    async def recall(self, query: str, dataset: str, *, user_id: str | None = None, session_id: str | None = None) -> str:
        """Сводка по датасету человека (GRAPH_COMPLETION). Датасета нет или ошибка — пустая строка («памяти нет»)."""
        async with self._trace_tool("memory_search", user_id, session_id, {"search_type": "graph_completion"}) as observation:
            response = await self._send(
                "POST",
                "/search",
                json={"searchType": "GRAPH_COMPLETION", "query": query, "datasets": [dataset]},
                timeout=SEARCH_TIMEOUT,
            )
            if response.status_code != 200:
                observation.update(level="ERROR", status=f"http {response.status_code}")
                logger.warning("cognee recall failed status=%d", response.status_code)
                return ""
            try:
                return "\n".join(self._texts(response.json()))
            except ValueError:
                observation.update(level="ERROR", status="unexpected_response")
                logger.warning("cognee recall: unexpected response shape")
                return ""

    async def recall_chunks(self, query: str, dataset: str, *, user_id: str | None = None, session_id: str | None = None) -> str:
        """Сырые чанки по запросу (CHUNKS): без LLM-синтеза, в разы быстрее GRAPH_COMPLETION — для фонового поиска по реплике."""
        async with self._trace_tool("memory_search", user_id, session_id, {"search_type": "chunks"}) as observation:
            response = await self._send(
                "POST",
                "/search",
                json={"searchType": "CHUNKS", "query": query, "datasets": [dataset]},
                timeout=SEARCH_TIMEOUT,
            )
            if response.status_code != 200:
                observation.update(level="ERROR", status=f"http {response.status_code}")
                logger.warning("cognee chunks failed status=%d", response.status_code)
                return ""
            try:
                payload = response.json()
            except ValueError:
                observation.update(level="ERROR", status="unexpected_response")
                logger.warning("cognee chunks: unexpected response shape")
                return ""
            texts: list[str] = []
            for item in payload if isinstance(payload, list) else []:
                if not isinstance(item, dict):
                    continue
                for chunk in item.get("search_result") or []:
                    if isinstance(chunk, dict) and isinstance(chunk.get("text"), str):
                        texts.append(chunk["text"])
                    elif isinstance(chunk, str):
                        texts.append(chunk)
            return "\n".join(texts)

    async def read_consent(self, dataset: str, *, user_id: str | None = None, session_id: str | None = None) -> str:
        """Текст документа-зерна согласия (CHUNKS-поиск «CONSENT memory») или пустая строка."""
        async with self._trace_tool("memory_search", user_id, session_id, {"search_type": "consent"}) as observation:
            response = await self._send(
                "POST",
                "/search",
                json={"searchType": "CHUNKS", "query": "CONSENT memory", "datasets": [dataset]},
            )
            if response.status_code != 200:
                observation.update(level="ERROR", status=f"http {response.status_code}")
                return ""
            try:
                chunks = self._texts(response.json())
            except ValueError:
                observation.update(level="ERROR", status="unexpected_response")
                return ""
            return next((chunk for chunk in chunks if "CONSENT memory" in chunk), "")

    async def _dataset_id(self, name: str) -> str | None:
        response = await self._send("GET", "/datasets")
        response.raise_for_status()
        for item in response.json():
            if isinstance(item, dict) and item.get("name") == name:
                return str(item.get("id"))
        return None

    async def dataset_exists(self, dataset: str) -> bool:
        """Датасет человека существует ⟺ его память включена."""
        return await self._dataset_id(dataset) is not None

    async def forget_dataset(self, dataset: str, *, user_id: str | None = None, session_id: str | None = None) -> bool:
        """Удалить датасет целиком. False — его и не было.

        Зовут очередь `memory_outbox` (операция `delete_dataset`: «Удалить всю память», выключение поиска по прошлым
        разговорам, перенесённые метки `memory_deletions` агента 0.8.8) и стирание аккаунта (синхронно, до `204`).
        False — вызов не выполнен: в TOOL-записи это ERROR `not_found`, чтобы метрика `tool_requests` его не считала.
        """
        async with self._trace_tool("memory_forget_dataset", user_id, session_id) as observation:
            dataset_id = await self._dataset_id(dataset)
            if dataset_id is None:
                observation.update(level="ERROR", status="not_found")
                return False
            response = await self._send("DELETE", f"/datasets/{dataset_id}")
            response.raise_for_status()
            return True

    async def aclose(self) -> None:
        await self._client.aclose()


def build_cognee_client(config: Any) -> CogneeClient | None:
    """Клиент по настройкам памяти или None, если адрес или сервисные креды не заданы (память «unavailable»)."""
    if not config.cognee_base_url or not config.cognee_email or not config.cognee_password:
        return None
    return CogneeClient(
        config.cognee_base_url,
        config.cognee_email,
        config.cognee_password.get_secret_value(),
    )
