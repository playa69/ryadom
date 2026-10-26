"""Спайк Cognee (PROTEUS-242, задача 0.3): документ на разговор, поиск, удаление одного документа и производных данных.

Запуск против локального или стендового Cognee: `COGNEE_URL=http://127.0.0.1:4801 uv run python scripts/cognee_spike.py`.
Сервисного пользователя скрипт регистрирует сам (только на локальном Cognee). Печатает вызовы, ответы (без ключей) и замеры.
Все тексты выдуманы.
"""

import asyncio
import json
import os
import time
import uuid

import httpx

URL = os.environ.get("COGNEE_URL", "http://127.0.0.1:4801").rstrip("/") + "/api/v1"
EMAIL = os.environ.get("COGNEE_EMAIL", "spike@example.com")
PASSWORD = os.environ.get("COGNEE_PASSWORD", "spike-password-123")
UNIQUE = "Фиолетовый-Барсук-" + uuid.uuid4().hex[:8]


def log(label: str, started: float, extra: str = "") -> None:
    print(f"[{time.perf_counter() - started:6.1f}s] {label} {extra}")


async def main() -> None:
    async with httpx.AsyncClient(base_url=URL, timeout=httpx.Timeout(600, connect=10)) as http:
        t = time.perf_counter()
        reg = await http.post("/auth/register", json={"email": EMAIL, "password": PASSWORD})
        log("register", t, str(reg.status_code))
        login = await http.post("/auth/login", data={"username": EMAIL, "password": PASSWORD})
        login.raise_for_status()
        http.headers["Authorization"] = "Bearer " + login.json()["access_token"]
        dataset = "spike_" + uuid.uuid4().hex[:6]

        doc1 = f"Человек: Меня зовут Алекс, я работаю в продажах. Недавно ссорился с сестрой Машей из-за {UNIQUE}.\nЧеловек: Хочу поговорить с руководителем до пятницы."
        doc2 = "Человек: Люблю гулять у воды по вечерам, это помогает расслабиться."

        t = time.perf_counter()
        added = await http.post("/add", files={"data": ("dialog-1.txt", doc1.encode(), "text/plain")}, data={"datasetName": dataset})
        log("add #1", t, f"{added.status_code} {json.dumps(added.json(), ensure_ascii=False)[:300]}")
        added2 = await http.post("/add", files={"data": ("dialog-2.txt", doc2.encode(), "text/plain")}, data={"datasetName": dataset})
        log("add #2", t, str(added2.status_code))

        t = time.perf_counter()
        cog = await http.post("/cognify", json={"datasets": [dataset]})
        log("cognify", t, f"{cog.status_code} {cog.text[:200]}")

        dsets = (await http.get("/datasets")).json()
        dataset_id = next(d["id"] for d in dsets if d["name"] == dataset)
        items = (await http.get(f"/datasets/{dataset_id}/data")).json()
        print("data items:", [(i.get("name"), i.get("id")) for i in items])

        async def chunks(query: str) -> list[str]:
            r = await http.post("/search", json={"searchType": "CHUNKS", "query": query, "datasets": [dataset]})
            if r.status_code != 200:
                return [f"HTTP {r.status_code}"]
            out: list[str] = []
            for item in r.json():
                for c in (item.get("search_result") or []) if isinstance(item, dict) else []:
                    out.append(c.get("text", "") if isinstance(c, dict) else str(c))
            return out

        t = time.perf_counter()
        found = await chunks(UNIQUE)
        log("CHUNKS по уникальной фразе", t, f"найдено {len(found)}, есть фраза: {any(UNIQUE in x for x in found)}")
        t = time.perf_counter()
        graph = await http.post("/search", json={"searchType": "GRAPH_COMPLETION", "query": f"Что известно про {UNIQUE}?", "datasets": [dataset]})
        log("GRAPH_COMPLETION", t, f"{graph.status_code} фраза в ответе: {UNIQUE in graph.text}")
        g = await http.get(f"/datasets/{dataset_id}/graph")
        nodes = g.json().get("nodes", []) if g.status_code == 200 else []
        print("graph nodes before:", len(nodes), "с фразой:", sum(UNIQUE in json.dumps(n, ensure_ascii=False) for n in nodes))

        target = next(i for i in items if "dialog-1" in str(i.get("name")))
        t = time.perf_counter()
        deleted = await http.delete(f"/datasets/{dataset_id}/data/{target['id']}")
        log("DELETE документа #1", t, f"{deleted.status_code} {deleted.text[:200]}")
        t = time.perf_counter()
        after = await chunks(UNIQUE)
        log("CHUNKS после удаления", t, f"найдено {len(after)}, есть фраза: {any(UNIQUE in x for x in after)}")
        graph2 = await http.post("/search", json={"searchType": "GRAPH_COMPLETION", "query": f"Что известно про {UNIQUE}?", "datasets": [dataset]})
        print("GRAPH_COMPLETION после удаления, фраза в ответе:", UNIQUE in graph2.text)
        g2 = await http.get(f"/datasets/{dataset_id}/graph")
        nodes2 = g2.json().get("nodes", []) if g2.status_code == 200 else []
        print("graph nodes after:", len(nodes2), "с фразой:", sum(UNIQUE in json.dumps(n, ensure_ascii=False) for n in nodes2))
        other = await chunks("гулять у воды")
        print("документ #2 цел:", any("гулять" in x for x in other))

        t = time.perf_counter()
        gone = await http.delete(f"/datasets/{dataset_id}")
        log("DELETE датасета", t, str(gone.status_code))
        print("датасет исчез:", all(d["name"] != dataset for d in (await http.get("/datasets")).json()))


asyncio.run(main())
