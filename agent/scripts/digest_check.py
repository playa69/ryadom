"""Проверка итогов разговоров и итогов недели без приложения, базы и сокетов: на вход сценарии, на выходе то, что уходит в модель и что вернулось.

    AGENT_INTERNAL_TOKEN=x AGENT_API_TOKEN=… LLM_BASE_URL=… LLM_MODE=proxy uv run python scripts/digest_check.py --out digests.json
    AGENT_INTERNAL_TOKEN=x LLM_MODE=template uv run python scripts/digest_check.py --replies scripts/digest_replies.json   # без модели: готовые ответы
    AGENT_INTERNAL_TOKEN=x LLM_MODE=proxy … uv run python scripts/digest_check.py --scenario work_week --show-prompts --runs 3

Цепочка та же, что в агенте: диалоги → итог каждого (`recaps.make_recap`) → итоги недели (`digests.build_messages` →
модель → `digests.clean_digest`, при отклонении один повтор). Запасного текста нет: если модель не ответила или оба ответа не прошли
проверку, текста недели нет. Без модели можно подставить готовые ответы (`--replies`): в `digest_replies.json` они написаны мной
вручную, чтобы показать форму результата, настоящий текст даст модель. Диалоги собираются в памяти, итог «своей рукой»
задаётся полем `takeaway`. Печатаются промпты (с `--show-prompts`), итог каждого разговора, сырой ответ, вердикт и автопроверки:
нет цитат, нет привязки к дню или разговору, нет «надо», нет счётчиков, длина. Тон и содержательность оценивает человек. Сценарии синтетические.
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.clients.llm import ModelError, build_models  # noqa: E402
from app.core.config import APP_CONFIG  # noqa: E402
from app.services import digests, recaps  # noqa: E402
from app.services.dialog_store import Dialog, Message  # noqa: E402

Turn = tuple[str, str]  # ("u" | "a", текст)


class ReplayChat:
    """Вместо модели: отдаёт готовые ответы по очереди (итоги разговоров, затем итоги недели)."""

    name = "replay"

    def __init__(self, replies: list[str]) -> None:
        self._replies = list(replies)

    async def complete(self, messages: list[dict[str, str]]) -> str:
        if not self._replies:
            raise ModelError("в файле ответов не хватает ответа")
        return self._replies.pop(0)


def talk(*turns: Turn) -> list[Turn]:
    return list(turns)


# Сценарий: имя, описание, отметки недели {день недели 0–6: (уровень 1–5, фактор)}, разговоры.
# Разговор: реплики, итог «своей рукой» (takeaway) или None, кризис, «Без памяти».
SCENARIOS: dict[str, dict[str, Any]] = {
    "work_week": {
        "about": "Тяжёлая неделя на работе: три разговора про начальника и дедлайн",
        "marks": {0: (2, "work"), 1: (1, "work"), 2: (1, "work"), 3: (2, "work"), 4: (3, "work")},
        "dialogs": [
            {"day": 0, "turns": talk(
                ("u", "Начальник при всех сказал, что мой отчёт никуда не годится, и я весь день не могу прийти в себя"),
                ("a", "Звучит очень обидно. Что задело сильнее всего?"),
                ("u", "Что при коллегах. Я три ночи над ним сидел и никто даже не спросил, как я"),
            ), "takeaway": None},
            {"day": 2, "turns": talk(
                ("u", "Дедлайн перенесли на четверг, я не успеваю и боюсь, что меня уволят из-за этого проекта"),
                ("a", "Ты на пределе. Давай по порядку: что именно не успеваешь?"),
                ("u", "Часть с аналитикой. Хочу попросить коллегу помочь, но стыдно признаваться"),
            ), "takeaway": None},
            {"day": 4, "turns": talk(
                ("u", "Поговорил с руководителем, оказалось, он просто не заметил, сколько я сделал, и извинился"),
                ("a", "Это большой шаг. Как ты себя чувствуешь после?"),
                ("u", "Легче. Хотя осадок остался, я всё равно устал от этой нервотрёпки на работе"),
            ), "takeaway": "Поговорил с руководителем, стало легче"},
        ],
    },
    "mixed_week": {
        "about": "Разные темы: работа, мама, сон",
        "marks": {0: (3, "work"), 1: (2, "people"), 2: (2, "sleep"), 3: (3, "people"), 4: (4, None), 5: (4, "people")},
        "dialogs": [
            {"day": 1, "turns": talk(
                ("u", "Мама опять звонила и учила меня жить, я сорвалась на неё и теперь чувствую вину"),
                ("a", "Вина после такого разговора понятна. Что хочется ей сказать?"),
                ("u", "Что я люблю её, но мне нужно, чтобы она меня слушала и не давала советов"),
            ), "takeaway": None},
            {"day": 2, "turns": talk(
                ("u", "Третью ночь просыпаюсь в четыре утра и не могу уснуть, в голове всё крутится про работу"),
                ("a", "Бессонница выматывает. Что крутится чаще всего?"),
                ("u", "Отчёт, который я не отправила, и страх, что снова что-то не так сделаю"),
            ), "takeaway": None},
            {"day": 5, "turns": talk(
                ("u", "Съездили с подругой за город, впервые за месяц выдохнула и ни о чём не думала"),
                ("a", "Как здорово. Что в этой поездке было самым лёгким?"),
                ("u", "Что можно просто молчать вместе и никому ничего не объяснять"),
            ), "takeaway": None},
        ],
    },
    "good_week": {
        "about": "Спокойная неделя, настроение растёт",
        "marks": {0: (3, None), 1: (4, "health"), 2: (4, None), 3: (5, "people"), 4: (4, None)},
        "dialogs": [
            {"day": 1, "turns": talk(
                ("u", "Начал ходить по утрам в парк, это неожиданно помогает, голова становится яснее"),
                ("a", "Рада слышать. Что ты замечаешь после прогулок?"),
                ("u", "Что меньше раздражаюсь и могу спокойно сесть за дела, без внутреннего напряжения"),
            ), "takeaway": None},
        ],
    },
    "money_family": {
        "about": "Деньги и отношения с мужем",
        "marks": {0: (2, "money"), 2: (2, "money"), 3: (1, "people"), 5: (3, "people")},
        "dialogs": [
            {"day": 0, "turns": talk(
                ("u", "Мы с мужем поссорились из-за денег, я потратила накопления на курсы и не сказала ему сразу"),
                ("a", "Тебе тревожно из-за этой ссоры. Что для тебя главное в этой ситуации?"),
                ("u", "Чтобы он понял, что мне нужно развиваться, и перестал считать каждую копейку"),
            ), "takeaway": None},
            {"day": 3, "turns": talk(
                ("u", "Муж не разговаривает со мной второй день, а долг по кредиту надо закрывать до конца месяца"),
                ("a", "Тяжело, когда дома тишина и ещё долги. Что тебе сейчас нужнее всего?"),
                ("u", "Чтобы мы сели и спокойно поговорили, без обвинений, как раньше"),
            ), "takeaway": None},
        ],
    },
    "marks_only": {
        "about": "Разговоров с итогом нет, только отметки",
        "marks": {0: (3, None), 1: (3, None), 2: (4, None)},
        "dialogs": [],
    },
    "short_and_crisis": {
        "about": "Короткий разговор и кризисный: итогов нет, неделя по одним отметкам",
        "marks": {0: (1, None), 1: (1, None), 2: (1, None), 3: (2, None)},
        "dialogs": [
            {"day": 1, "turns": talk(("u", "Привет"), ("a", "Я рядом. С чего начнём?"), ("u", "Да так")), "takeaway": None},
            {"day": 2, "turns": talk(
                ("u", "Мне кажется, что я не хочу больше жить, всё потеряло смысл и я очень устала от всего"),
                ("a", "Я слышу, как тебе плохо. Ты в безопасности сейчас?"),
            ), "takeaway": None, "crisis": True},
        ],
    },
    "unsaved_and_written": {
        "about": "«Без памяти» не даёт итога, написанный вручную даёт",
        "marks": {0: (3, "work"), 1: (3, "work"), 2: (2, "work")},
        "dialogs": [
            {"day": 0, "turns": talk(
                ("u", "Это про семейное, не хочу, чтобы оно сохранялось, мы с сестрой поругались из-за наследства"),
                ("a", "Хорошо, это останется между нами. Что случилось?"),
                ("u", "Она хочет продать квартиру, а мне там жить, и я не знаю, как с ней говорить"),
            ), "takeaway": None, "memory_mode": "off"},
            {"day": 2, "turns": talk(
                ("u", "Взялся за новый проект на работе, интересно, но боюсь не потянуть сроки и подвести команду"),
                ("a", "Азарт и страх вместе. Что в проекте тебя больше всего тянет?"),
                ("u", "Что я наконец делаю то, в чём разбираюсь, а не рутину"),
            ), "takeaway": "Рад новому проекту, но волнуюсь за сроки"},
        ],
    },
}

_DAYS = ("Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс")
WEEK_START = "2026-10-19"


def date_of(day: int) -> str:
    import datetime

    return (datetime.date.fromisoformat(WEEK_START) + datetime.timedelta(days=day)).isoformat()


def make_dialog(index: int, spec: dict[str, Any]) -> Dialog:
    date = date_of(spec["day"])
    messages = [
        Message(id=f"m{index}-{i}", role="user" if who == "u" else "assistant", text=text, created_at=f"{date}T10:{i:02d}:00Z")
        for i, (who, text) in enumerate(spec["turns"])
    ]
    dialog = Dialog(id=f"d{index}", user_id="u", started_at=f"{date}T10:00:00Z", messages=messages)
    dialog.memory_mode = spec.get("memory_mode", "on")
    dialog.crisis_seen = bool(spec.get("crisis"))
    return dialog


# Автопроверки текста недели (то, что можно проверить машиной).
_COUNT = re.compile(r"\b\d+\s*(дн|разговор|итог|раз)|\b(один|два|три|четыре|пять)\s+(дня|дней|разговор|итог)", re.IGNORECASE)


def checks(text: str, recap_texts: list[str], marks: list[dict[str, Any]]) -> dict[str, bool]:
    return {
        "no_quote": not digests.has_quotation(text, recap_texts),
        "no_day_or_dialog_tie": digests._SPECIFIC.search(text) is None,
        "no_advice_word": digests._FORBIDDEN.search(text) is None,
        "no_average": digests._AVERAGE.search(text) is None,
        "no_streak": digests._STREAK.search(text) is None,
        "no_counters": _COUNT.search(text) is None,
        "length_ok": digests.WEEK_SENTENCES[0] <= digests.sentence_count(text) <= digests.WEEK_SENTENCES[1],
    }


async def run_scenario(name: str, spec: dict[str, Any], chat: Any, show_prompts: bool) -> dict[str, Any]:
    marks = [
        {"date": date_of(day), "mood": mood, "factor": factor} for day, (mood, factor) in sorted(spec["marks"].items())
    ]
    print(f"\n{'=' * 78}\n{name}: {spec['about']}")
    print("отметки:", ", ".join(f"{_DAYS[d]}={m}" + (f"/{f}" if f else "") for d, (m, f) in sorted(spec["marks"].items())))
    week_recaps: list[dict[str, Any]] = []
    out_dialogs = []
    for index, d in enumerate(spec["dialogs"]):
        dialog = make_dialog(index, d)
        verdict = "итога нет: " + (
            "кризис" if dialog.crisis_seen else "«Без памяти»" if dialog.memory_mode != "on" else "человек сказал меньше 40 знаков"
        )
        text: str | None = None
        source = None
        if recaps.eligible(dialog):
            if d.get("takeaway"):
                text, source = d["takeaway"], "manual (поле «Что забираешь с собой?»)"
            else:
                if show_prompts:
                    print(f"\n--- промпт итога разговора {index + 1} ---")
                    for m in recaps.build_messages(dialog):
                        print(f"[{m['role']}]\n{m['content']}")
                text = await recaps.make_recap(chat, dialog, 60.0)
                source = "auto" if text else None
                if text is None:
                    verdict = "итога нет: модель не ответила или ответ не прошёл проверку"
        print(f"\nразговор {index + 1} ({_DAYS[d['day']]}): ", end="")
        for who, line in d["turns"]:
            print(f"\n    {'человек' if who == 'u' else 'Рядом  '}: {line}", end="")
        print(f"\n  → итог [{source}]: {text}" if text else f"\n  → {verdict}")
        out_dialogs.append({"day": d["day"], "recap": text, "source": source})
        if text:
            week_recaps.append({"date": date_of(d["day"]), "text": text})

    prompt = digests.build_messages("week", WEEK_START, marks, week_recaps)
    if show_prompts:
        print("\n--- промпт итогов недели ---")
        for m in prompt:
            print(f"[{m['role']}]\n{m['content']}")
    raw: str | None = None
    final: str | None = None
    verdict = ""
    for attempt in (1, 2):  # как в агенте: отклонённый ответ просим повторить один раз
        try:
            raw = await chat.complete(prompt)
        except ModelError:
            verdict = "модель не ответила: текста недели нет"
            break
        print(f"\nсырой ответ модели (попытка {attempt}):\n  {raw}")
        final = digests.clean_digest("week", raw, marks, source_texts=[r["text"] for r in week_recaps])
        verdict = "ответ принят" if final else "ответ отклонён проверкой"
        if final:
            break
    if final is None:
        print(f"\nИТОГОВ НЕДЕЛИ НЕТ ({verdict}). Запасного текста нет.")
        return {"scenario": name, "dialogs": out_dialogs, "raw": raw, "verdict": verdict, "text": None, "checks": {"text_present": False}}
    print(f"\nИТОГИ НЕДЕЛИ ({verdict}):\n  {final}")
    result = checks(final, [r["text"] for r in week_recaps], marks)
    print("автопроверки:", ", ".join(f"{k}={'ok' if v else 'FAIL'}" for k, v in result.items()))
    return {"scenario": name, "dialogs": out_dialogs, "raw": raw, "verdict": verdict, "text": final, "checks": result}


# Ответы, какими модель может ответить на сценарий work_week: что проверка пропускает, а что отбраковывает и почему.
CANDIDATES: list[tuple[str, str]] = [
    ("годный: общий обзор", "Эта неделя прошла в напряжении из-за работы: ты переживал из-за оценок и сроков. К её концу стало заметно легче, "
     "после трудного разговора ты выдохнул. Видно, как для тебя важно, чтобы твой труд замечали. Я рядом."),
    ("привязка к дню", "Неделя началась тяжело. В понедельник тебя задела критика, а к пятнице стало легче. Я рядом."),
    ("привязка к разговору", "В одном из разговоров ты рассказывал о критике, и это было непросто. Потом стало легче. Я рядом."),
    ("дословная цитата из итога", "Ты поговорил с руководителем, стало легче, и это дало опору. Неделя была непростой. Рядом люди, которые поддержат."),
    ("в кавычках", "Ты назвал неделю «ужасной и выматывающей до предела». К концу стало легче. Рядом люди, которые поддержат."),
    ("совет «надо»", "Неделя была тяжёлой. Тебе надо больше отдыхать, и всё наладится. Рядом люди, которые поддержат."),
    ("статистика", "Неделя была тяжёлой: тяжёлых дней было четыре, а чаще всего ты отмечал «так себе». Рядом люди, которые поддержат."),
    ("слишком коротко", "Неделя была непростой."),
]


def run_candidates() -> int:
    marks = [{"date": date_of(i), "mood": m, "factor": "work"} for i, m in enumerate((2, 1, 1, 2, 3))]
    sources = ["Ты поговорил с руководителем, стало легче и спокойнее после этого разговора", "Поговорил с руководителем, стало легче"]
    print("Как проверка итогов недели встречает разные ответы модели (сценарий work_week):")
    for label, reply in CANDIDATES:
        verdict = digests.clean_digest("week", reply, marks, source_texts=sources)
        print(f"\n- {label}: {'ПРИНЯТ' if verdict else 'отбракован → шаблон'}\n    {reply}")
    return 0


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenario", action="append", help="имя сценария (можно несколько); по умолчанию все")
    parser.add_argument("--show-prompts", action="store_true", help="печатать промпты итога разговора и итогов недели")
    parser.add_argument("--runs", type=int, default=1, help="сколько раз прогнать каждый сценарий (разброс ответов модели)")
    parser.add_argument("--candidates", action="store_true", help="показать, какие ответы модели проверка принимает и отбраковывает")
    parser.add_argument("--replies", help="JSON с готовыми ответами вместо модели (см. digest_replies.json)")
    parser.add_argument("--out", help="записать результат в JSON")
    args = parser.parse_args()

    if args.candidates:
        return run_candidates()
    chat, _ = build_models(APP_CONFIG.llm)
    replies = json.loads(Path(args.replies).read_text(encoding="utf-8")) if args.replies else None
    if chat is None and replies is None:
        print("Нужна модель (LLM_MODE=proxy, AGENT_API_TOKEN, LLM_BASE_URL) или --replies с готовыми ответами: запасного текста нет.")
        return 2
    print("режим:", "готовые ответы из " + args.replies if replies is not None and chat is None else "модель " + APP_CONFIG.llm.chat_model)
    names = args.scenario or list(SCENARIOS)
    results = []
    for name in names:
        for _ in range(args.runs):
            scenario_chat = chat
            if scenario_chat is None:
                entry = replies[name]  # type: ignore[index]
                scenario_chat = ReplayChat([*entry["recaps"], entry["week"]])
            results.append(await run_scenario(name, SCENARIOS[name], scenario_chat, args.show_prompts))
    failed = [(r["scenario"], k) for r in results for k, v in r["checks"].items() if not v]
    print(f"\n{'=' * 78}\nсценариев: {len(results)}, провалов автопроверок: {len(failed)}", failed or "")
    if args.out:
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
