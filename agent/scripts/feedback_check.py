"""Живая проверка сценариев из обратной связи тестировщицы (разговор в проде 13.10) против агента на настоящем Gemini Live.

    uv run python scripts/make_fixtures.py --out fixtures/          # один раз (нужен ключ Gemini)
    uv run python scripts/feedback_check.py --url http://127.0.0.1:8012 --token <токен> --pcm-dir fixtures/ --runs 3

Агент уже запущен в режиме gemini_live (скрипт его не запускает). Каждый сценарий идёт `--runs` раз с новым человеком и
диалогом. Исход каждого прогона:
  ok        ответ по существу (не лекция про язык, не шаблон, не просьба повторить)
  repeat    агент попросил повторить («плохо слышно»): допустимо для тихого обрывка, но не идеально
  lecture   агент заговорил о языке («только по-русски»): плохо, из-за этого всё и затевалось
  template  шаблонный запасной ответ (модель промолчала)
  silence   ответа нет совсем
Для каждого прогона печатаются расшифровка и ответ: оценку тона и пользы делает человек, автомат ловит только то, что
можно проверить по тексту. Код возврата 1, если есть лекции про язык, тишина или (при `--strict`) шаблоны.
"""

import argparse
import asyncio
import json
import random
import re
import sys
import time
import uuid
from collections import Counter
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from live_smoke import Conn, cyrillic_share, first, open_dialog, open_socket, send_voice  # noqa: E402

from app.services.replies import REPEAT_REQUEST, REPLIES, is_language_lecture  # noqa: E402

TOPIC_SWITCH = re.compile(r"о чём[- ]то другом|о чём ещё|что ещё хочется|как прошёл (твой )?день|что у тебя сейчас на душе", re.IGNORECASE)
ANSWER_WAIT = 40.0  # сколько ждать ответ после реплики

# Реплики нагрузочного теста (loadtest/locustfile.py): на них в проде 6% ответов пришли без звука.
LOADTEST_MESSAGES = [
    "Привет. Сегодня был тяжёлый день, чувствую усталость и раздражение.",
    "Поссорился с близким человеком, не могу отпустить эту ситуацию.",
    "Тревожно на работе, постоянно кажется, что я не справляюсь.",
    "Не могу уснуть уже несколько ночей, мысли крутятся по кругу.",
    "Чувствую себя одиноко, даже когда вокруг люди.",
    "Злость накрывает из-за мелочей, а потом стыдно за это.",
    "Расскажи, как понять, что мне на самом деле нужно?",
    "У меня завтра важный разговор, и я очень переживаю.",
    "Иногда кажется, что ничего не получается, хотя я стараюсь.",
    "Хочу научиться спокойнее реагировать на критику.",
    "Спасибо, мне уже немного легче. Что можно сделать прямо сейчас?",
    "А как ты думаешь, почему я так остро реагирую на эту тему?",
]

# Рассказ о себе и слова, по которым видно, что ответ остался в теме.
HOBBIES = [
    ("Я недавно начала ходить на танцы по вечерам.", r"танц|вечер|занят"),
    ("По выходным стараюсь выбираться за город на велосипеде.", r"выходн|велосипед|город|поезд|прогул"),
    ("Недавно начала ходить на керамику, леплю чашки.", r"керамик|леп|чашк|глин"),
    ("Вчера ходила в театр, правда, спектакль мне не понравился.", r"театр|спектакл|понрави|постановк"),
    ("Я завела рыбок, теперь у меня аквариум.", r"рыб|аквариум"),
    ("Мы с подругой по субботам бегаем в парке.", r"бег|парк|подруг|суббот"),
    ("Начал учить испанский по вечерам.", r"испанск|язык|учи|вечер"),
    ("Вечером гуляла по набережной, было очень красиво.", r"набережн|гуля|прогул|красив|вечер"),
]

# Реплики, на которые агент обычно говорит о себе в прошедшем времени или краткой формой («понял», «рад»).
GENDER_PROMPTS = [
    "Ты меня понял?",
    "Ты рад, что я пришла поговорить?",
    "Ты меня вообще услышал?",
    "Ты готов меня выслушать?",
    "Ты запомнил, что я тебе говорила?",
    "Прости, я пробормотала что-то невнятное",
]
_GENDER_PAIRS = [
    ("понял", "поняла"), ("рад", "рада"), ("услышал", "услышала"), ("расслышал", "расслышала"), ("готов", "готова"),
    ("уверен", "уверена"), ("запомнил", "запомнила"), ("хотел", "хотела"), ("смог", "смогла"), ("сменил", "сменила"),
    ("старался", "старалась"), ("благодарен", "благодарна"), ("должен", "должна"), ("ждал", "ждала"),
]


def self_gender(answer: str) -> tuple[int, int]:
    """Сколько раз агент сказал о себе в мужском и в женском роде: «я понял», «я не расслышала», «рад тебя слышать»."""
    text = answer.lower()
    masc = fem = 0
    for m, f in _GENDER_PAIRS:
        # «я (не|очень|тоже|всё) понял» или предложение начинается с формы («Рада, что ты здесь»).
        for form, is_fem in ((m, False), (f, True)):
            pattern = rf"(?:\bя\s+(?:\w+\s+){{0,2}}|\bбуду\s+|(?:^|[.!?,]\s+)(?:не\s+|очень\s+|так\s+)?){form}\b"
            count = len(re.findall(pattern, text))
            if is_fem:
                fem += count
            else:
                masc += count
    return masc, fem
VOICE_TAIL = 8.0  # сколько ждать озвучку после assistant_end


async def new_session(http: httpx.AsyncClient, auth: dict, ws_base: str, voice: str | None = None) -> Conn:
    user = str(uuid.uuid4())
    dialog = await open_dialog(http, auth, user, voice)
    conn = await open_socket(ws_base, auth, user, dialog["dialogId"])
    await conn.wait(0, lambda sl: any(e.type == "tts_end" and e.d.get("messageId") == "greeting" for e in sl), 15)
    return conn


async def collect(conn: Conn, since: int, started: float) -> dict:
    """Дождаться исхода реплики: ответ (текст и озвучка), пустая расшифровка без ответа или тишина."""
    deadline = started + ANSWER_WAIT
    ended_at: float | None = None
    while time.monotonic() < deadline:
        sl = conn.evs[since:]
        ends = [e for e in sl if e.type == "assistant_end" and e.d.get("messageId") != "greeting"]
        if ends:
            ended_at = ended_at or time.monotonic()
            mid = ends[0].d.get("messageId")
            if first(sl, "tts_end", messageId=mid) is not None or time.monotonic() - ended_at > VOICE_TAIL:
                break
        await asyncio.sleep(0.1)
    sl = conn.evs[since:]
    transcript = next((e.d.get("text", "") for e in sl if e.type == "transcript" and e.d.get("final")), None)
    ends = [e for e in sl if e.type == "assistant_end" and e.d.get("messageId") != "greeting"]
    answer = ends[0].d.get("text", "") if ends else ""
    voiced = bool(ends) and first(sl, "tts_start", messageId=ends[0].d.get("messageId")) is not None
    first_sound = None
    if ends and voiced:
        start = first(sl, "tts_start", messageId=ends[0].d.get("messageId"))
        first_sound = round(start.t - started, 2) if start else None
    return {
        "transcript": transcript,
        "answer": answer,
        "answers": len(ends),
        "voiced": voiced,
        "first_sound": first_sound,
        "errors": [e.d.get("code") for e in sl if e.type == "error"],
    }


def classify(result: dict) -> str:
    answer = result["answer"]
    if not answer:
        return "silence"
    if answer == REPEAT_REQUEST:
        return "repeat"
    if is_language_lecture(answer):
        return "lecture"
    if answer in REPLIES:
        return "template"
    return "ok"


async def voice_turn(conn: Conn, pcm: bytes, pace: float) -> dict:
    since = conn.mark()
    started = await send_voice(conn, pcm, pace)
    return await collect(conn, since, started)


async def text_turn(conn: Conn, text: str) -> dict:
    since = conn.mark()
    started = await conn.send({"type": "user_message", "id": str(uuid.uuid4()), "text": text})
    return await collect(conn, since, started)


class Report:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, scenario: str, run: int, result: dict, outcome: str, note: str = "", quiet: bool = False) -> None:
        self.rows.append({"scenario": scenario, "run": run, "outcome": outcome, "note": note, **result})
        if quiet and outcome == "ok":
            return
        shown = f"{result['transcript']!r}" if result["transcript"] is not None else "-"
        print(f"  [{outcome:<8}] run {run}: слышно {shown} → {result['answer'][:150]!r}{'' if result['voiced'] else '  (БЕЗ ЗВУКА)'}{note}")


async def scenarios(args: argparse.Namespace) -> Report:
    auth = {"Authorization": f"Bearer {args.token}"}
    ws_base = args.url.replace("http", "ws", 1)
    pcm_dir = Path(args.pcm_dir)

    def pcm(name: str) -> bytes:
        return (pcm_dir / f"{name}_16k.pcm").read_bytes()

    only = set(args.only.split(",")) if args.only else None
    report = Report()

    def wanted(name: str) -> bool:
        return only is None or name in only

    async with httpx.AsyncClient(base_url=args.url, timeout=20) as http:
        # L1–L4: короткое слово «устала» в трудных условиях и «например» после реплики агента.
        for name in ("ustala_quiet", "ustala_quieter", "ustala_cut", "ustala_x3", "ustala_male_quiet", "naprimer_quiet"):
            if not wanted(name):
                continue
            print(f"\n{name}: короткое слово, которое раньше расшифровывалось чужим языком")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base, "male" if "male" in name else None)
                try:
                    if name.startswith("naprimer"):
                        await text_turn(conn, "Мне трудно вставать по утрам, хочу придумать что-то для себя")
                    result = await voice_turn(conn, pcm(name), args.pace)
                finally:
                    await conn.close()
                report.add(name, run, result, classify(result))

        # L5: рассказ про увлечение — ответ с вопросом по теме.
        if wanted("hobby"):
            print("\nhobby: рассказ про увлечение голосом (ждём вопрос по теме, не «здорово» и не смену темы)")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    result = await voice_turn(conn, pcm("hobby"), args.pace)
                finally:
                    await conn.close()
                answer = result["answer"]
                topical = bool(re.search(r"танц|занят|вечер|увлеч", answer, re.IGNORECASE))
                outcome = classify(result)
                note = "" if outcome != "ok" else ("" if answer.rstrip().endswith("?") else "  НЕТ ВОПРОСА")
                note += "" if topical else "  НЕ ПО ТЕМЕ"
                report.add("hobby", run, result, outcome, note)

        # L6: «не знаю» — остаться в теме.
        if wanted("ne_znayu"):
            print("\nne_znayu: «Я не знаю.» — не менять тему")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    await text_turn(conn, "Мне тяжело вставать по утрам, никак не могу собраться")
                    result = await text_turn(conn, "Я не знаю.")
                finally:
                    await conn.close()
                outcome = classify(result)
                note = "  СМЕНА ТЕМЫ" if TOPIC_SWITCH.search(result["answer"]) else ""
                report.add("ne_znayu", run, result, "ok" if outcome == "ok" and not note else (outcome if outcome != "ok" else "switch"), note)

        # L7: прямая просьба о совете — не отказ и не рецепт, а помочь разобраться (REQ-GEN-03 п. 5: советов нет даже мягких,
        # вместо них — что задевает, гипотеза, выбор за человеком). Тон и пользу оценивает человек по выписанным ответам.
        if wanted("podskazhi"):
            print("\npodskazhi: «Подскажи, что можно придумать» — не отказ и не рецепт, а помочь разобраться")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    await text_turn(conn, "Хочу приучить себя вставать раньше, но не получается")
                    result = await text_turn(conn, "Подскажи, что можно придумать")
                finally:
                    await conn.close()
                answer = result["answer"]
                refusal = re.search(r"не могу (давать|дать|советовать)", answer, re.IGNORECASE)
                recipe = re.search(r"\bпопробуй|\bтебе (стоит|надо|нужно)|\bсоветую|можно попробовать", answer, re.IGNORECASE)
                note = "  ОТКАЗ" if refusal else "  РЕЦЕПТ" if recipe else ""
                outcome = classify(result)
                report.add("podskazhi", run, result, outcome if outcome != "ok" or not note else "advice", note)

        # L8–L9: целая фраза на другом языке и просьба сменить язык: по-русски.
        for name in ("en_sentence", "switch_lang"):
            if not wanted(name):
                continue
            print(f"\n{name}: ответ должен быть по-русски")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    result = await voice_turn(conn, pcm(name), args.pace)
                finally:
                    await conn.close()
                share = cyrillic_share(result["answer"])
                outcome = "ok" if share >= 0.9 and result["answer"] else ("silence" if not result["answer"] else "english")
                report.add(name, run, result, outcome, f"  кириллицы {share:.2f}")

        # G2 (информационно, до исправления будет «шаблон»): пауза посреди мысли.
        if wanted("pause"):
            print("\npause: часть мысли, пауза 3 с, продолжение (ждём один ответ на всю мысль)")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    since = conn.mark()
                    await send_voice(conn, pcm("unfinished_part1"), args.pace)
                    await asyncio.sleep(3.0)
                    started = await send_voice(conn, pcm("unfinished_part2"), args.pace)
                    await asyncio.sleep(1.0)
                    result = await collect(conn, since, started)
                    result["answers"] = len([e for e in conn.evs[since:] if e.type == "assistant_end" and e.d.get("messageId") != "greeting"])
                finally:
                    await conn.close()
                outcome = classify(result)
                note = f"  ответов: {result['answers']}"
                report.add("pause", run, result, outcome if result["answers"] == 1 else "split", note)

        # ─── Сценарии по запросу (--only): дорогие или для отдельных измерений ─────────────────────────────────────────

        def asked(name: str) -> bool:
            return only is not None and name in only

        # Длинные набранные диалоги, как в нагрузочном тесте (там 6% ответов пришли без звука): доля ответов без звука.
        if asked("long_text"):
            print(f"\nlong_text: {args.long_dialogs} диалога по {args.long_turns} набранных реплик (как нагрузочный тест)")
            rnd = random.Random(7)
            for d in range(1, args.long_dialogs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    for n in range(1, args.long_turns + 1):
                        result = await text_turn(conn, rnd.choice(LOADTEST_MESSAGES))
                        outcome = "ok" if result["voiced"] and result["answer"] else ("silence" if not result["answer"] else "novoice")
                        report.add("long_text", d * 100 + n, result, outcome, quiet=True)
                finally:
                    await conn.close()
                rows = [r for r in report.rows if r["scenario"] == "long_text" and r["run"] // 100 == d]
                print(f"  диалог {d}: ответов {sum(bool(r['answer']) for r in rows)}, без звука {sum(r['outcome'] == 'novoice' for r in rows)}")

        # Рассказ о себе (увлечение, событие): ответ должен заканчиваться вопросом по теме, а не одним одобрением.
        if asked("hobbies"):
            print("\nhobbies: рассказ о себе — ждём вопрос по теме")
            for n, (text, topic) in enumerate(HOBBIES, 1):
                for run in range(1, args.runs + 1):
                    conn = await new_session(http, auth, ws_base)
                    try:
                        result = await text_turn(conn, text)
                    finally:
                        await conn.close()
                    answer = result["answer"].rstrip()
                    question = answer.endswith("?")
                    on_topic = bool(re.search(topic, answer, re.IGNORECASE))
                    praise_only = not question and bool(re.search(r"здорово|замечательн|прекрасн|интересн|отличн|чудесн", answer, re.IGNORECASE))
                    outcome = "ok" if question and on_topic else ("praise" if praise_only else ("offtopic" if question else "noquestion"))
                    report.add("hobbies", n * 10 + run, result, outcome)

        # Настоящая английская речь (фикстура en_real): ответ по-русски; что видит человек в расшифровке.
        for name in ("en_real", "en_real_short"):
            if not asked(name):
                continue
            print(f"\n{name}: настоящая английская речь — ответ по-русски, расшифровка какая есть")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    result = await voice_turn(conn, pcm(name), args.pace)
                finally:
                    await conn.close()
                share = cyrillic_share(result["answer"])
                heard_cyr = cyrillic_share(result["transcript"] or "")
                outcome = "ok" if result["answer"] and share >= 0.9 else ("silence" if not result["answer"] else "english")
                report.add(name, run, result, outcome, f"  ответ кириллицей {share:.2f}, расшифровка кириллицей {heard_cyr:.2f}")

        # Фраза, оборванная на полуслове, в реальном темпе, пауза, продолжение: шаблон посреди мысли или один ответ?
        if asked("pause_cut"):
            print("\npause_cut: оборвано на полуслове, пауза 2,5 с, продолжение (реальный темп)")
            for run in range(1, args.runs + 1):
                conn = await new_session(http, auth, ws_base)
                try:
                    since = conn.mark()
                    first_end = await send_voice(conn, pcm("unfinished_part1_cut"), 0.1)
                    await asyncio.sleep(2.5)
                    between = [e for e in conn.evs[since:] if e.type == "assistant_end"]
                    since2 = conn.mark()
                    started = await send_voice(conn, pcm("unfinished_part2"), 0.1)
                    result = await collect(conn, since2, started)
                    if result["answer"]:  # озвучка могла начаться ещё до продолжения: ищем tts_start с начала сценария
                        mid = next(e.d.get("messageId") for e in conn.evs[since2:] if e.type == "assistant_end" and e.d.get("messageId") != "greeting")
                        result["voiced"] = first(conn.evs[since:], "tts_start", messageId=mid) is not None
                    await asyncio.sleep(3.0)
                    ends = [e for e in conn.evs[since:] if e.type == "assistant_end" and e.d.get("messageId") != "greeting"]
                finally:
                    await conn.close()
                first_text = between[0].d.get("text", "") if between else ""
                kind = "template" if first_text in REPLIES else ("answered" if first_text else "waited")
                note = f"  до продолжения: {kind} {first_text[:60]!r}; всего ответов {len(ends)}; первый ответ через {round((between[0].t - first_end) if between else 0, 2)} с"
                report.add("pause_cut", run, result, kind, note)

        # Род агента о себе: при мужском голосе — «понял», при женском — «поняла».
        for voice in ("male", "female"):
            if not asked(f"gender_{voice}"):
                continue
            print(f"\ngender_{voice}: агент о себе в роде голоса ({voice})")
            for n, text in enumerate(GENDER_PROMPTS, 1):
                for run in range(1, args.runs + 1):
                    conn = await new_session(http, auth, ws_base, voice)
                    try:
                        result = await text_turn(conn, text)
                    finally:
                        await conn.close()
                    masc, fem = self_gender(result["answer"])
                    wrong = fem if voice == "male" else masc
                    right = masc if voice == "male" else fem
                    outcome = "wrong" if wrong else ("right" if right else "neutral")
                    report.add(f"gender_{voice}", n * 10 + run, result, outcome, f"  м:{masc} ж:{fem}")

        # Статистика ответов без звука: серия коротких текстовых реплик.
        if wanted("voiceless"):
            print("\nvoiceless: серия реплик, доля ответов без звука")
            phrases = ["Привет", "Сегодня был обычный день", "Много работы", "Устала немного", "Хочу отдохнуть", "Мечтаю о море", "Не знаю, куда поехать",
                       "Люблю тишину", "Иногда грущу вечером", "Спасибо, что слушаешь"]
            conn = await new_session(http, auth, ws_base)
            try:
                for n, phrase in enumerate(phrases, 1):
                    result = await text_turn(conn, phrase)
                    report.add("voiceless", n, result, "ok" if result["voiced"] and result["answer"] else ("silence" if not result["answer"] else "novoice"))
            finally:
                await conn.close()
    return report


def summary(report: Report) -> int:
    print("\n" + "=" * 78)
    print("ИТОГ (исходы по сценариям)")
    bad = 0
    names = list(dict.fromkeys(row["scenario"] for row in report.rows))
    for name in names:
        counts = Counter(row["outcome"] for row in report.rows if row["scenario"] == name)
        total = sum(counts.values())
        line = ", ".join(f"{k} {v}" for k, v in counts.most_common())
        print(f"  {name:<20} {total} прогонов: {line}")
        bad += counts.get("lecture", 0) + counts.get("silence", 0) + counts.get("english", 0)
    voiced = [row for row in report.rows if row["answer"]]
    if voiced:
        silent = sum(not row["voiced"] for row in voiced)
        print(f"\nОтветов: {len(voiced)}, из них без звука: {silent} ({silent / len(voiced):.0%})")
        sounds = sorted(row["first_sound"] for row in voiced if row["first_sound"])
        if sounds:
            print(f"Первый звук: медиана {sounds[len(sounds) // 2]:.2f} с, максимум {sounds[-1]:.2f} с")
    return bad


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8012")
    parser.add_argument("--token", required=True)
    parser.add_argument("--pcm-dir", required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--pace", type=float, default=0.03, help="пауза между кадрами голоса, с (0,1 — реальное время)")
    parser.add_argument("--only", help="сценарии через запятую: ustala_quiet, hobby, ne_znayu, podskazhi, switch_lang, pause, voiceless; по запросу: long_text, hobbies, en_real, en_real_short, pause_cut, gender_male, gender_female")
    parser.add_argument("--long-dialogs", type=int, default=3, help="long_text: сколько диалогов")
    parser.add_argument("--long-turns", type=int, default=30, help="long_text: сколько реплик в диалоге")
    parser.add_argument("--json", help="куда записать сырые результаты")
    parser.add_argument("--strict", action="store_true", help="шаблоны и просьбы повторить тоже считать провалом")
    args = parser.parse_args()
    report = asyncio.run(scenarios(args))
    failed = summary(report)
    if args.json:
        Path(args.json).write_text(json.dumps(report.rows, ensure_ascii=False, indent=1), encoding="utf-8")
    if args.strict:
        failed += sum(row["outcome"] in ("template", "repeat", "novoice", "split") for row in report.rows)
    raise SystemExit(1 if failed else 0)
