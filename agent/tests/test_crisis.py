"""Кризисная ветка: детектор, автомат и скрипт (REQ-SAFE-01…03, capability crisis-safety). Реплики синтетические."""

import asyncio

import pytest

from app.clients.background_model import ModelError
from app.services import crisis_script as script
from app.services.crisis import CrisisFlow, State, classify_with_model, classify_words, parse_answer, parse_model_level

# Прежний детектор: пять фраз. Набор — красный уровень в разных формулировках, не только прямых.
OLD_WORDS = ("не хочу жить", "покончить", "убить себя", "умереть", "нет смысла жить")

RED_SET = [
    "я больше не хочу жить",
    "хочу умереть",
    "думаю покончить с собой",
    "мне незачем жить",
    "иногда думаю про суицид",
    "хочу вскрыть вены",
    "я режу себя когда плохо",
    "лучше бы меня не было",
    "хочу повеситься",
    "думаю наложить на себя руки",
    "хочу навредить себе",
    "жить не хочу",
    "мне не хочется жить",
    "скоро всё закончится, я так решил, таблеток хватит",  # без прямых слов: ловит только модель
    "хочу, чтобы меня не стало",  # без прямых слов: ловит только модель
]
WORDS_ONLY_MISSES = {RED_SET[-1], RED_SET[-2]}

YELLOW_SET = ["всё бессмысленно", "я устал от всего", "я никому не нужен", "нет сил так дальше", "всё безнадёжно"]
NONE_SET = ["сегодня хороший день", "расскажи анекдот", "мне грустно из-за дождя", "давай просто поболтаем"]


class FakeModel:
    """Вторая ступень по таблице: что вернуть на какую реплику."""

    name = "fake"

    def __init__(self, answers: dict[str, str] | None = None, fail: bool = False) -> None:
        self.answers = answers or {}
        self.fail = fail
        self.calls = 0

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        if self.fail:
            raise ModelError("down")
        return self.answers.get(messages[-1]["content"], "NONE")

    async def aclose(self) -> None: ...


def test_old_detector_catches_about_a_third_of_the_set():
    caught = [t for t in RED_SET if any(w in t.lower() for w in OLD_WORDS)]
    assert len(caught) / len(RED_SET) < 0.5


def test_word_stage_recall_on_the_red_set():
    caught = [t for t in RED_SET if classify_words(t) == "red"]
    assert set(RED_SET) - set(caught) == WORDS_ONLY_MISSES
    assert len(caught) / len(RED_SET) >= 0.85


def test_model_stage_closes_the_rest_of_the_red_set():
    model = FakeModel({t: "RED" for t in WORDS_ONLY_MISSES})
    levels = [classify_words(t) or asyncio.run(classify_with_model(model, t)) for t in RED_SET]
    assert levels.count("red") / len(RED_SET) >= 0.9


@pytest.mark.parametrize("text", YELLOW_SET)
def test_hopelessness_without_direct_words_is_yellow(text):
    assert classify_words(text) == "yellow"


@pytest.mark.parametrize("text", NONE_SET)
def test_ordinary_talk_is_not_flagged(text):
    assert classify_words(text) is None


def test_red_word_wins_over_yellow():
    assert classify_words("всё бессмысленно, хочу умереть") == "red"


def test_yo_and_case_do_not_matter():
    assert classify_words("Всё Безнадёжно") == "yellow"


def test_model_stage_failure_or_absence_means_no_level():
    assert asyncio.run(classify_with_model(None, "текст")) is None
    assert asyncio.run(classify_with_model(FakeModel(fail=True), "текст")) is None


@pytest.mark.parametrize(
    ("answer", "level"), [("RED", "red"), (" yellow.", "yellow"), ("NONE", None), ("что-то", None)]
)
def test_model_answer_parsing(answer, level):
    assert parse_model_level(answer) == level


@pytest.mark.parametrize(
    ("text", "answer"),
    [
        ("да", "yes"),
        ("Да, бывают", "yes"),
        ("нет", "no"),
        ("нет, не бывает", "no"),
        ("не знаю", "unknown"),
        ("ну не знаю", "unknown"),
        ("расскажу тебе длинную историю про мой день на работе", None),
        ("погода", None),
    ],
)
def test_direct_answers(text, answer):
    assert parse_answer(text) == answer


def test_red_first_step_is_the_fixed_phrase_and_opens_the_sheet():
    flow = CrisisFlow()
    decision = flow.decide("хочу умереть", classify_words("хочу умереть"), "words")
    assert decision is not None and decision.text == script.RED_FIRST and decision.sheet and decision.pinned
    assert flow.state is State.RED_CALL and flow.active and flow.addendum()


def test_ordinary_talk_leaves_the_model_to_answer():
    flow = CrisisFlow()
    assert flow.decide("привет", None) is None and not flow.active and flow.addendum() == ""


def test_next_message_after_step_one_asks_whether_the_person_is_safe():
    flow = CrisisFlow()
    flow.decide("хочу умереть", "red", "words")
    decision = flow.decide("не знаю что сказать", None)
    assert decision is not None and decision.text == script.RED_CHECK and decision.ask == "safe"


def test_timer_goes_to_the_same_check():
    flow = CrisisFlow()
    flow.decide("хочу умереть", "red", "words")
    assert flow.check_safety().text == script.RED_CHECK


def test_call_button_cancels_the_check():
    flow = CrisisFlow()
    flow.decide("хочу умереть", "red", "words")
    flow.call_pressed()
    assert flow.state is State.LISTENING


@pytest.mark.parametrize("answer", ["no", "unknown"])
def test_unsafe_answer_gives_112_and_the_sheet(answer):
    flow = CrisisFlow()
    flow.decide("хочу умереть", "red", "words")
    flow.check_safety()
    decision = flow.answer_safety(answer)
    assert decision.text == script.RED_UNSAFE and decision.sheet and "112" in decision.text


def test_safe_answer_keeps_the_call_button_pinned_and_lets_the_model_listen():
    flow = CrisisFlow()
    flow.decide("хочу умереть", "red", "words")
    flow.check_safety()
    decision = flow.decide("да", None)
    assert decision is not None and decision.text == script.RED_SAFE and decision.pinned and not decision.sheet
    assert flow.decide("мне просто тяжело", None) is None


def test_reminder_is_every_fourth_reply_not_every_one():
    flow = CrisisFlow()
    flow.decide("хочу умереть", "red", "words")
    flow.check_safety()
    flow.decide("да", None)
    said = [d.text if (d := flow.decide(f"реплика {n}", None)) else None for n in range(1, 9)]
    assert said == [None, None, None, script.RED_REMINDER, None, None, None, script.RED_REMINDER]


def test_red_words_again_do_not_repeat_the_call_offer():
    flow = CrisisFlow()
    flow.decide("хочу умереть", "red", "words")
    flow.check_safety()
    flow.decide("да", None)
    decision = flow.decide("всё равно хочу умереть", "red", "words")
    assert decision is None or decision.text != script.RED_FIRST


def test_return_after_the_call():
    flow = CrisisFlow()
    assert flow.after_call() is None
    flow.decide("хочу умереть", "red", "words")
    decision = flow.after_call()
    assert decision is not None and decision.text == script.RED_RETURN and not decision.sheet and not decision.ask


def test_yellow_asks_the_direct_question():
    flow = CrisisFlow()
    decision = flow.decide("всё бессмысленно", "yellow", "words")
    assert (
        decision is not None
        and decision.text == script.YELLOW_ASK
        and decision.ask == "thoughts"
        and not decision.sheet
    )


def test_yellow_yes_goes_to_red_step_one():
    flow = CrisisFlow()
    flow.decide("всё бессмысленно", "yellow", "words")
    decision = flow.decide("да", None)
    assert decision is not None and decision.text == script.RED_FIRST and decision.sheet


def test_yellow_no_goes_to_calm_talk_with_the_banner():
    flow = CrisisFlow()
    flow.decide("всё бессмысленно", "yellow", "words")
    decision = flow.decide("нет", None)
    assert decision is not None and decision.text is None and decision.banner
    assert flow.state is State.CALM and flow.addendum()


def test_red_after_calm_still_triggers_step_one():
    flow = CrisisFlow()
    flow.decide("всё бессмысленно", "yellow", "words")
    flow.decide("нет", None)
    decision = flow.decide("хочу умереть", "red", "words")
    assert decision is not None and decision.text == script.RED_FIRST


def test_partial_transcript_reacts_only_to_red_and_only_once():
    flow = CrisisFlow()
    assert flow.screen("всё бессмысленно") is None
    assert flow.screen("хочу умереть") == "red"
    flow.decide("хочу умереть", "red", "words")
    assert flow.screen("хочу умереть") is None


@pytest.mark.parametrize(
    "phrase", [*script.PHRASES, script.CALM_ADDENDUM.split("Не обещай")[0], script.PUSH_TEXT, script.SHEET_TITLE]
)
def test_script_has_no_forbidden_phrases(phrase):
    lower = phrase.lower().replace("ё", "е")
    assert not any(bad.replace("ё", "е") in lower for bad in script.FORBIDDEN)
    assert "(а)" not in phrase  # фразы без рода


def test_script_never_asks_about_method_or_details_and_does_not_hang_up():
    for phrase in script.PHRASES:
        lower = phrase.lower()
        assert "как именно" not in lower and "каким способом" not in lower and "расскажи подробнее" not in lower
        assert "до свидания" not in lower and "прощай" not in lower


def test_script_matches_the_concept():
    assert script.RED_FIRST.startswith("Спасибо, что рассказываешь мне об этом.")
    assert "Нажми кнопку на экране" in script.RED_FIRST
    assert "112" in script.RED_UNSAFE and "Я никуда не ухожу" in script.RED_UNSAFE
    assert script.REMINDER_EVERY in (3, 4)
