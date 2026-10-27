"""Итоги недели и года (add-mood-diary, D6): `POST /v1/users/{userId}/digests`."""

import re

from tests.conftest import AUTH, make_client


class ScriptedChat:
    name = "scripted"

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.seen: list[list[dict[str, str]]] = []

    async def complete(self, messages):
        self.seen.append(messages)
        return self.reply

    async def aclose(self) -> None:
        return None


def marks(*moods, factor="work"):
    return [{"date": f"2026-10-{19 + i:02d}", "mood": mood, "factor": factor} for i, mood in enumerate(moods)]


def post(client, user_id, body, headers=AUTH):
    return client.post(f"/v1/users/{user_id}/digests", json=body, headers=headers)


WEEK = {"kind": "week", "periodStart": "2026-10-19"}
FORBIDDEN = re.compile(r"\bнадо\b|\bдолжен\b|подряд|\d+[.,]\d+\s*из", re.IGNORECASE)


def test_needs_the_internal_token(client, user_id):
    assert post(client, user_id, {**WEEK, "marks": marks(3, 3, 4)}, headers={}).status_code == 401


def test_week_template_text_is_deterministic_and_clean(client, user_id):
    body = {**WEEK, "marks": marks(3, 4, 4, 5)}
    first = post(client, user_id, body).json()
    assert post(client, user_id, body).json() == first
    assert first["stats"] == {"markedDays": 4, "hardDays": 0, "mostFrequent": 4}
    assert 2 <= len(re.findall(r"[.!?]", first["text"])) <= 6
    assert "работа" in first["text"] and "чаще всего" not in first["text"].lower()
    assert not FORBIDDEN.search(first["text"])
    assert "людей" not in first["text"] and "люди" not in first["text"]


def test_hard_week_ends_with_a_soft_line_about_people(client, user_id):
    reply = post(client, user_id, {**WEEK, "marks": marks(1, 1, 1, 3)}).json()
    assert reply["stats"]["hardDays"] == 3
    assert reply["text"].rstrip().endswith("и я тоже здесь.")
    assert "люди" in reply["text"]


def test_validation(client, user_id):
    bad = [
        {**WEEK, "marks": [{"date": "2026-10-19", "mood": 6}]},
        {**WEEK, "marks": [{"date": "19.10.2026", "mood": 3}]},
        {**WEEK, "periodStart": "вчера", "marks": marks(3)},
        {"kind": "month", "periodStart": "2026-10-19", "marks": marks(3)},
        {"kind": "year", "periodStart": "2026-01-01", "marks": marks(3)},
        {**WEEK, "marks": marks(3) * 8},
    ]
    for body in bad:
        response = post(client, user_id, body)
        assert response.status_code == 400, body
        assert response.json()["error"]["code"] == "AGENT_VALIDATION"
    assert post(client, "not-a-uuid", {**WEEK, "marks": marks(3)}).status_code == 400


def test_model_text_is_used_when_it_is_fine_and_gets_only_codes(user_id):
    chat = ScriptedChat("Неделя была разной. Ты заглядывал в себя. Чаще всего было спокойно. Спасибо, что делишься.")
    with make_client(None, chat=chat) as client:
        reply = post(client, user_id, {**WEEK, "marks": marks(3, 3, 4)}).json()
    assert reply["text"].startswith("Неделя была разной.")
    sent = " ".join(m["content"] for m in chat.seen[0])
    assert "2026-10-19: 3, фактор: работа" in sent
    assert "@" not in sent


def test_model_text_with_forbidden_words_falls_back_to_the_template(user_id):
    for bad in (
        "Тебе надо отдыхать. Это важно. Вот так. И так.",
        "Средний балл недели 3,5 из 5. Это хорошо. Так бывает. Всё ок.",
        "Ты отмечал пять дней подряд. Это здорово. Так держать. Рядом.",
        "Слишком коротко.",
    ):
        with make_client(None, chat=ScriptedChat(bad)) as client:
            reply = post(client, user_id, {**WEEK, "marks": marks(3, 3, 4)}).json()
        assert not FORBIDDEN.search(reply["text"]), bad
        assert reply["text"].startswith("На этой неделе")


def test_model_failure_is_a_502_without_the_body(user_id):
    from app.clients.llm import ModelError

    class Down(ScriptedChat):
        async def complete(self, messages):
            raise ModelError("секрет в тексте")

    with make_client(None, chat=Down("")) as client:
        response = post(client, user_id, {**WEEK, "marks": marks(3, 3, 4)})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "DIGEST_UNAVAILABLE"
    assert "секрет" not in response.text


def test_prompt_forbids_quoting():
    from app.services import digests

    system = digests.build_messages("week", "2026-10-19", marks(3, 3, 4))[0]["content"]
    task = digests.build_messages("week", "2026-10-19", marks(3, 3, 4))[1]["content"]
    assert "Не цитируй" in system
    assert "без цитат" in task.lower()


def test_quotation_marks_with_more_than_two_words_are_a_quotation():
    from app.services import digests

    for quoted in (
        "«я больше не могу так работать»",
        '"я больше не могу"',
        "„всё это слишком тяжело“",
        "“мне нужна пауза от всего”",
    ):
        assert digests.has_quotation(f"Неделя была разной, ты сказал {quoted}.")
    # одно–два слова в кавычках — не цитата: названия уровней и тем
    assert not digests.has_quotation("Чаще всего было «тяжело», а ещё «так себе».")
    assert not digests.has_quotation("Тема «работа» возвращалась.")


def test_six_words_in_a_row_from_what_the_person_said_are_a_quotation():
    from app.services import digests

    said = ["Начальник постоянно меняет приоритеты и я не успеваю закончить ничего важного"]
    assert digests.has_quotation("Ты говорил, что начальник постоянно меняет приоритеты и я не успеваю, и это выматывает.", said)
    assert not digests.has_quotation("Ты говорил про смену приоритетов на работе и нехватку времени.", said)
    assert not digests.has_quotation("Начальник меняет приоритеты.", said)  # короче шести слов


def test_model_text_with_a_quotation_falls_back_to_the_template(user_id):
    bad = "Неделя была непростой. Ты написал «я больше не могу так работать». Это было важно. Спасибо, что делишься."
    with make_client(None, chat=ScriptedChat(bad)) as client:
        reply = post(client, user_id, {**WEEK, "marks": marks(3, 3, 4)}).json()
    assert "не могу" not in reply["text"]
    assert reply["text"].startswith("На этой неделе")


def test_clean_digest_rejects_a_verbatim_piece_of_the_source():
    from app.services import digests

    reply = "Неделя была ровной. Ты писал, что начальник постоянно меняет приоритеты и я не успеваю, поэтому сил мало. Спасибо, что делишься. Я рядом."
    said = ["начальник постоянно меняет приоритеты и я не успеваю"]
    assert digests.clean_digest("week", reply, marks(3, 3, 4), said) is None
    assert digests.clean_digest("week", reply, marks(3, 3, 4), []) is not None


def test_week_recaps_reach_the_model_but_are_not_quoted_back(user_id):
    recap = {"date": "2026-10-20", "text": "Ты не можешь больше терпеть начальника каждый день. Тебе важно, чтобы тебя услышали"}
    quoted = (
        "Эта неделя была непростой, и ты не можешь больше терпеть начальника каждый день. "
        "Ты отмечал настроение и находил время для себя. Чаще всего было нормально. "
        "Заметно, что тебе важны люди рядом. Я рад быть рядом."
    )
    chat = ScriptedChat(quoted)
    with make_client(None, chat=chat) as client:
        body = {**WEEK, "marks": marks(3, 3, 4), "recaps": [recap]}
        text = post(client, user_id, body).json()["text"]
    assert "Итоги разговоров недели" in chat.seen[0][1]["content"] and "начальника" in chat.seen[0][1]["content"]
    assert "Чаще всего было нормально" not in text  # ответ модели с дословной цитатой отбракован, подставлен шаблон из содержания итогов
    assert text.startswith("На этой неделе")
