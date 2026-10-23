"""REST-клиент к Cognee API для PoC-болванки — замена cognee_mcp.py для своего деплоя.

Наш Cognee в twc-sber500 (ns agent) живёт только внутри кластера, поэтому клиент
ходит в REST /api/v1 через port-forward:

    kubectl -n agent port-forward svc/cognee 18000:8000

В деплое включён multi-user access control (ENABLE_BACKEND_ACCESS_CONTROL=true) —
без него /search НЕ фильтрует по датасетам (проверено 2026-10-21: recall юзера A
возвращал факты юзера B). Поэтому клиент логинится сервисным пользователем
agent-service@cognee.dev; email/пароль — из env COGNEE_SERVICE_EMAIL /
COGNEE_SERVICE_PASSWORD, иначе из k8s-секрета cognee-service-account (как
proxy_key в stub.py; значения не печатаются).

Интерфейс повторяет CogneeMCP (connect/remember/recall/aclose), чтобы stub.py
переключался одной строкой. remember = add + cognify (как MCP-инструмент remember
в постоянном режиме), recall = search GRAPH_COMPLETION по датасету юзера.
Адрес — COGNEE_BASE_URL (по умолчанию http://127.0.0.1:18000).
"""

import base64
import os
import subprocess
from pathlib import Path

import httpx

BASE_URL = os.environ.get("COGNEE_BASE_URL", "http://127.0.0.1:18000").rstrip("/")
KUBECONFIG = Path(__file__).resolve().parents[2] / "admin-kubeconfig.yaml"


def _service_creds() -> tuple[str, str]:
    email = os.environ.get("COGNEE_SERVICE_EMAIL")
    password = os.environ.get("COGNEE_SERVICE_PASSWORD")
    if email and password:
        return email, password
    result = subprocess.run(
        ["kubectl", f"--kubeconfig={KUBECONFIG}", "-n", "agent", "get", "secret",
         "cognee-service-account", "-o", "jsonpath={.data.COGNEE_SERVICE_PASSWORD}"],
        capture_output=True, check=True,
    )
    return "agent-service@cognee.dev", base64.b64decode(result.stdout).decode()


class CogneeREST:
    def __init__(self) -> None:
        # cognify большого транскрипта — до нескольких минут LLM-ходов
        self._client = httpx.AsyncClient(base_url=f"{BASE_URL}/api/v1", timeout=httpx.Timeout(600.0, connect=15.0))

    async def connect(self) -> None:
        email, password = _service_creds()
        response = await self._client.post("/auth/login", data={"username": email, "password": password})
        response.raise_for_status()
        token = response.json()["access_token"]
        self._client.headers["Authorization"] = f"Bearer {token}"

    async def remember(self, data: str, dataset: str) -> str:
        response = await self._client.post(
            "/add",
            files={"data": ("transcript.txt", data.encode(), "text/plain")},
            data={"datasetName": dataset},
        )
        response.raise_for_status()
        # add только складывает документ; граф строит cognify (как MCP remember)
        response = await self._client.post("/cognify", json={"datasets": [dataset]})
        response.raise_for_status()
        return response.text[:300]

    async def recall(self, query: str, dataset: str, top_k: int = 8) -> str:
        try:
            response = await self._client.post(
                "/search",
                json={"searchType": "GRAPH_COMPLETION", "query": query, "datasets": [dataset], "topK": top_k},
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            # датасета ещё нет (404) и т.п. — stub читает это как «памяти нет»
            return f"Error: {error.response.status_code} {error.response.text[:200]}"
        payload = response.json()
        if isinstance(payload, list):
            return "\n".join(str(item) for item in payload)
        return str(payload)

    async def aclose(self) -> None:
        await self._client.aclose()
