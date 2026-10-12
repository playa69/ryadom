"""Изоляция людей (I5): факты одного человека не попадают в сводку, API и «что изменилось» другого. Параметризованный
property-тест на случайных наборах (hypothesis в зависимостях нет, поэтому фиксированные зёрна)."""

import random
from pathlib import Path

import pytest

from tests.conftest import AUTH
from tests.memory_support import CONSENT, FakeModel, make_client, user

WORDS = ["джаз", "пластинки", "горы", "велосипед", "акварель", "шахматы", "йога", "сад", "керамика", "театр", "кино", "рыбалка"]


@pytest.mark.parametrize("seed", range(6))
def test_one_persons_memory_never_reaches_another(tmp_path: Path, seed: int) -> None:
    rng = random.Random(seed)
    people = [user() for _ in range(3)]
    owned: dict[str, set[str]] = {}
    with make_client(tmp_path / "i.sqlite3", FakeModel(), MEMORY_BRIEF_LEVEL="full") as client:
        for person in people:
            client.put(f"/v1/users/{person}/memory/settings", json={"enabled": True, "consentVersion": CONSENT}, headers=AUTH)
            owned[person] = set()
            for _ in range(rng.randint(1, 5)):
                text = f"Любит {rng.choice(WORDS)} и {rng.choice(WORDS)} {rng.randint(100, 999)}"
                response = client.post(
                    f"/v1/users/{person}/memory/facts", json={"category": "interest", "text": text}, headers=AUTH
                )
                if response.status_code == 201:
                    owned[person].add(response.json()["text"])
        store = client.app.state.store  # type: ignore[attr-defined]
        dialogs = {p: client.post(f"/v1/users/{p}/dialogs", headers=AUTH).json()["dialogId"] for p in people}
        client.portal.call(client.app.state.memory.drain)  # type: ignore[union-attr,attr-defined]
        for person in people:
            others = set().union(*(owned[p] for p in people if p != person))
            seen = {f["text"] for f in client.get(f"/v1/users/{person}/memory", headers=AUTH).json()["facts"]}
            assert seen == owned[person]
            exported = client.get(f"/v1/users/{person}/memory/export", headers=AUTH).text
            brief = store.memory_brief(store.get(person, dialogs[person]))
            for text in others:
                assert text not in exported and text not in brief
            assert sum(text in brief for text in owned[person]) == min(len(owned[person]), 2)  # лимит интересов в сводке
            # чужой диалог и чужие факты недоступны
            stranger = next(p for p in people if p != person)
            assert client.get(f"/v1/users/{person}/memory/changes?dialogId={dialogs[stranger]}", headers=AUTH).status_code == 404
        victim, attacker = people[0], people[1]
        fact_id = client.get(f"/v1/users/{victim}/memory", headers=AUTH).json()["facts"][0]["id"]
        assert (
            client.patch(f"/v1/users/{attacker}/memory/facts/{fact_id}", json={"status": "active"}, headers=AUTH).status_code
            == 404
        )
        assert client.delete(f"/v1/users/{attacker}/memory/facts/{fact_id}", headers=AUTH).status_code == 204
        assert fact_id in {f["id"] for f in client.get(f"/v1/users/{victim}/memory", headers=AUTH).json()["facts"]}
        client.delete(f"/v1/users/{attacker}/memory", headers=AUTH)
        assert len(client.get(f"/v1/users/{victim}/memory", headers=AUTH).json()["facts"]) == len(owned[victim])
