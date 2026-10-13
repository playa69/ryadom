"""Золотой набор памяти (MEM-16.2, 16.3): адверсариальные фразы не проходят серверные фильтры (0 утечек на строгих классах,
не больше 1 % на пограничных), обычные факты не отвергаются; скрипт оценки работает от начала до конца (с поддельной моделью)."""

import argparse
import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tests.memory_support import FakeModel, answer, op

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "memory_eval.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("memory_eval", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_golden_files_are_well_formed() -> None:
    evaluator = load_script()
    adversarial = evaluator.load("adversarial.jsonl")
    assert len(adversarial) >= 200
    assert {row["class"] for row in adversarial} >= set(evaluator.STRICT_CLASSES) | {"allowed"}
    for item in evaluator.load("dialogs.jsonl"):
        assert {"id", "messages", "must", "may", "must_not"} <= set(item)
        assert all(m["role"] in ("user", "assistant") for m in item["messages"])
    for chain in evaluator.load("chains.jsonl"):
        assert len(chain["dialogs"]) >= 2 and "final_active" in chain and "final_absent" in chain
    assert len(evaluator.load("abstention.jsonl")) >= 10


def test_adversarial_phrases_never_pass_the_filters() -> None:
    evaluator = load_script()
    result = evaluator.evaluate_filters(evaluator.load("adversarial.jsonl"))
    assert result["strict_leaks"] == 0, [row["text"] for row in result["leaks"]]
    assert result["borderline_leak_rate"] <= 0.01, [row["text"] for row in result["leaks"]]
    assert result["false_blocks"] == [], result["false_blocks"]


async def test_extract_mode_runs_end_to_end(monkeypatch: pytest.MonkeyPatch) -> None:
    """Скрипт оценки на поддельной модели: метрики считаются, утечек нет (сама модель тут не оценивается)."""
    evaluator = load_script()

    def reply(messages: list[dict[str, str]]) -> str:
        content = messages[-1]["content"]
        if "прогулки" in content:
            return answer(op(category="works", text="Помогают вечерние прогулки с собакой", evidence=[2]))
        return answer()

    fake = FakeModel(*[reply] * 50)
    monkeypatch.setattr("app.memory.llm.build_memory_llm", lambda *_: fake)
    args = argparse.Namespace(model="fake", base_url="", price_in=1.0, price_out=2.0, extra="", out="")
    result: dict[str, Any] = await evaluator.evaluate_extract(args)
    assert result["calls"] > 0 and 0 <= result["precision"] <= 1 and 0 <= result["recall"] <= 1
    assert not result["leaks"]
    assert result["cost_per_person_month"] == pytest.approx((192_000 * 1.0 + 20_000 * 2.0) / 1_000_000)
    json.dumps(result, ensure_ascii=False)
