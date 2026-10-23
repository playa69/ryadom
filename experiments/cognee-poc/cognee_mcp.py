"""Минимальный MCP-клиент к Cognee-серверу (SSE + basic auth) для PoC-болванки.

Протокол: GET /sse открывает стрим, первое событие `endpoint` даёт путь для POST JSON-RPC;
ответы на вызовы приходят в стрим событиями `message` с тем же id. Креды — из окружения
COGNEE_MCP_USER/COGNEE_MCP_PASS, значения не печатаются.
"""

import asyncio
import json
import os
from typing import Any

import httpx
from httpx_sse import aconnect_sse

SSE_URL = "https://mcp.fantomas404.ru/sse"


class CogneeMCP:
    def __init__(self) -> None:
        user = os.environ.get("COGNEE_MCP_USER")
        password = os.environ.get("COGNEE_MCP_PASS")
        if not user or not password:
            raise RuntimeError("Нет COGNEE_MCP_USER/COGNEE_MCP_PASS в окружении")
        self._auth = (user, password)
        self._client = httpx.AsyncClient(auth=self._auth, timeout=httpx.Timeout(600.0, connect=15.0))
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._post_url: str | None = None
        self._reader: asyncio.Task | None = None
        self._ready = asyncio.Event()

    async def connect(self) -> None:
        self._connect_error: Exception | None = None
        self._reader = asyncio.create_task(self._read_loop())
        await asyncio.wait_for(self._ready.wait(), timeout=20)
        if self._connect_error is not None:
            raise RuntimeError(f"MCP SSE не поднялся: {self._connect_error}") from self._connect_error
        await self._rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "ryadom-stub", "version": "0.1.0"},
        })
        await self._notify("notifications/initialized")

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise RuntimeError(json.dumps(result, ensure_ascii=False)[:500])
        content = result.get("content", [])
        return "\n".join(part.get("text", "") for part in content if part.get("type") == "text")

    async def remember(self, data: str, dataset: str) -> str:
        return await self.call_tool("remember", {"data": data, "dataset_name": dataset})

    async def recall(self, query: str, dataset: str, top_k: int = 8) -> str:
        return await self.call_tool("recall", {"query": query, "datasets": dataset, "top_k": top_k})

    async def _rpc(self, method: str, params: dict[str, Any]) -> Any:
        self._id += 1
        future = asyncio.get_running_loop().create_future()
        self._pending[self._id] = future
        response = await self._client.post(
            self._post_url,
            json={"jsonrpc": "2.0", "id": self._id, "method": method, "params": params},
        )
        response.raise_for_status()
        return await future

    async def _notify(self, method: str) -> None:
        response = await self._client.post(
            self._post_url, json={"jsonrpc": "2.0", "method": method, "params": {}}
        )
        response.raise_for_status()

    async def _read_loop(self) -> None:
        try:
            async with aconnect_sse(self._client, "GET", SSE_URL) as source:
                async for event in source.aiter_sse():
                    if event.event == "endpoint":
                        base = SSE_URL.removesuffix("/sse")
                        self._post_url = base + event.data
                        self._ready.set()
                    elif event.event == "message":
                        message = json.loads(event.data)
                        future = self._pending.pop(message.get("id"), None)
                        if future is not None and not future.done():
                            if "error" in message:
                                future.set_exception(RuntimeError(str(message["error"])))
                            else:
                                future.set_result(message.get("result", {}))
        except Exception as error:
            if not self._ready.is_set():
                self._connect_error = error
                self._ready.set()
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)

    async def aclose(self) -> None:
        if self._reader:
            self._reader.cancel()
        await self._client.aclose()
