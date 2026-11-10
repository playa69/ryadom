"""Кризисная ветка: словари, ответы на вопросы и переходы шагов без сокета и моделей.

`openspec/changes/extend-crisis-branch`: «Распознавание кризиса в реплике», «Скрипт красного уровня», «Жёлтый уровень»,
«Спокойный режим в кризисе». Реплики синтетические."""

import re

import pytest

from app.clients.risk_classifier import parse_level
from app.services import crisis_script as script
from app.services.crisis_script import CrisisFlow, Stage, detect, parse_answer

FIXED = [
    script.STEP1,
    script.STEP2_ASK,
    script.STEP2_UNSAFE,
    script.STEP2_SAFE,
    script.STEP3_REMINDER,
    script.STEP4_RETURN,
    script.YELLOW_ASK,
]


@pytest.mark.parametrize("text", ["Мне кажется, я хочу УМЕРЕТЬ", "Нет смысла жить", "думаю про суицид", "хочу навредить себе"])
def test_dictionary_finds_red(text: str) -> None:
    assert detect(text) == "red"


@pytest.mark.parametrize("text", ["всё бессмысленно", "я устала от всего", "чувствую, что никому не нужен"])
def test_dictionary_finds_yellow(text: str) -> None:
    assert detect(text) == "yellow"


def test_dictionary_ignores_the_ordinary() -> None:
    assert detect("сегодня был тяжёлый день на работе") is None


def test_red_wins_over_yellow() -> None:
    assert detect("всё бессмысленно, хочу умереть") == "red"


@pytest.mark.parametrize(
    ("text", "expected"),
    [("Да", "yes"), ("да, я в безопасности", "yes"), ("Нет", "no"), ("нет, мне опасно", "no"), ("Не знаю", "unknown"), ("что-то другое", "unknown")],
)
def test_parse_answer(text: str, expected: str) -> None:
    assert parse_answer(text) == expected


def test_red_goes_through_the_steps() -> None:
    flow = CrisisFlow()
    move = flow.react("red", "хочу умереть")
    assert (move.stage, move.level, move.say) == (Stage.HELP, "crisis", script.STEP1)
    asked = flow.react(None, "ну вот")  # заговорил, не нажав кнопку
    assert (asked.stage, asked.say) == (Stage.ASK_SAFE, script.STEP2_ASK)
    safe = flow.react(None, "да")
    assert (safe.stage, safe.say, safe.show_call) == (Stage.STAY, script.STEP2_SAFE, True)


@pytest.mark.parametrize("answer", ["нет", "не знаю", "ну такое"])
def test_unsafe_or_unclear_answer_gives_112(answer: str) -> None:
    flow = CrisisFlow()
    flow.react("red", "хочу умереть")
    flow.ask_safe()
    move = flow.react(None, answer)
    assert (move.stage, move.say, move.show_call) == (Stage.CALL112, script.STEP2_UNSAFE, True)


def test_help_wait_asks_about_safety() -> None:
    flow = CrisisFlow()
    flow.react("red", "хочу умереть")
    assert flow.ask_safe().say == script.STEP2_ASK


def test_reminder_is_rare_and_the_call_is_not_repeated_every_reply() -> None:
    flow = CrisisFlow()
    flow.react("red", "хочу умереть")
    flow.react(None, "Да, я в безопасности")  # ссылка на листе помощи: сразу шаг 2б
    moves = [flow.react(None, f"реплика {i}") for i in range(1, 9)]
    said = [m.say if m else None for m in moves]
    assert said.count(script.STEP3_REMINDER) == 2 and said[script.REMINDER_EVERY - 1] == script.STEP3_REMINDER
    assert all(s is None for i, s in enumerate(said) if (i + 1) % script.REMINDER_EVERY)


def test_repeated_red_in_the_branch_does_not_restart_it() -> None:
    flow = CrisisFlow()
    flow.react("red", "хочу умереть")
    flow.react(None, "да")
    assert flow.react("red", "всё равно хочу умереть") is None


def test_return_after_the_call() -> None:
    flow = CrisisFlow()
    assert flow.returned() is None  # вне ветки возврата нет
    flow.react("red", "хочу умереть")
    move = flow.returned()
    assert (move.stage, move.say) == (Stage.CHECK, script.STEP4_RETURN)
    assert not flow.red_active


def test_yellow_asks_and_yes_means_red() -> None:
    flow = CrisisFlow()
    ask = flow.react("yellow", "всё бессмысленно")
    assert (ask.stage, ask.level, ask.say) == (Stage.ASK_HOPELESS, "concern", script.YELLOW_ASK)
    move = flow.react(None, "да")
    assert (move.stage, move.say) == (Stage.HELP, script.STEP1)


def test_yellow_no_means_calm_banner_and_the_model_answers() -> None:
    flow = CrisisFlow()
    flow.react("yellow", "всё бессмысленно")
    move = flow.react(None, "нет")
    assert (move.stage, move.level, move.say, move.text) == (Stage.CALM, "concern", None, script.CALM_BANNER)
    assert flow.calm and flow.react("yellow", "опять всё бессмысленно") is None  # вопрос второй раз не задаётся


def test_frame_carries_stage_level_and_source() -> None:
    frame = CrisisFlow().react("red", "хочу умереть").frame("model")
    assert frame == {"type": "safety", "text": script.SCREEN_TEXT, "level": "crisis", "stage": "help", "source": "model"}


def test_fixed_phrases_have_no_gender_and_no_forbidden_wording() -> None:
    """«Спокойный режим в кризисе»: ни рода, ни обещаний и пустых утешений."""
    forbidden = ("между нами", "глупост", "всё будет хорошо", "все будет хорошо", "другим ещё хуже")
    for phrase in FIXED:
        lower = phrase.lower()
        assert not any(word in lower for word in forbidden), phrase
        assert not re.search(r"\b\w+(ла|л)\(а\)|\b(сказал|написал|устал)\b", lower), phrase


def test_only_the_step_one_phrase_is_the_legacy_crisis_reply() -> None:
    from app.services.replies import CRISIS_REPLY, CRISIS_SAFETY_TEXT

    assert (CRISIS_REPLY, CRISIS_SAFETY_TEXT) == (script.STEP1, script.SCREEN_TEXT)


@pytest.mark.parametrize(("raw", "level"), [({"level": "red"}, "red"), ({"level": "yellow"}, "yellow"), ({"level": "x"}, "none"), (None, "none"), ("red", "none")])
def test_model_answer_is_parsed_safely(raw: object, level: str) -> None:
    assert parse_level(raw) == level
