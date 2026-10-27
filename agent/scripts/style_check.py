"""Живая проверка манеры ответов: однообразие, допрос, советы, род — на настоящем Gemini Live, без агента.

    GEMINI_API_KEY=… [GEMINI_BASE_URL=… GEMINI_RELAY_TOKEN=…] AGENT_INTERNAL_TOKEN=x \
        uv run python scripts/style_check.py --runs 3 --out style.json [--prompt-module old_prompt.py]

Каждый сценарий — несколько набранных реплик подряд в одной сессии (ответы модели на реплики не влияют: так прогоны
сравнимы). Промпт по умолчанию — тот, что уходит в Gemini сейчас (`system_prompt(voice)` + `LIVE_ADDENDUM`); с
`--prompt-module` — функция `prompt(voice)` из указанного файла (например, промпт прежней версии для сравнения).

Метрики считаются по тексту ответов (расшифровке голоса модели):
  question     доля ответов, которые кончаются вопросом
  dead_end     доля ответов без зацепки: ни вопроса, ни приглашения продолжить — разговор тянуть приходится человеку
  chars        медиана длины ответа в знаках (и отношение к длине реплики человека)
  long_chars   медиана длины ответа на длинную реплику человека (от 200 знаков): не сжат ли ответ в одну фразу
  stock        доля ответов с дежурными оборотами («я здесь, чтобы», «как прошёл день», «понимаю, как», «совершенно нормально»…)
  same_start   доля ответов, начатых теми же двумя словами, что один из прошлых ответов в этом разговоре
  advice       доля ответов-инструкций в сценариях «что мне делать» («попробуй», «тебе стоит», «советую»…)
  self_gender  ответы, где агент говорит о себе не в роде своего голоса
  user_gender  ответы, где агент обращается к человеку не в его роде (род задан сценарием или неизвестен: тогда ошибка — мужской)
Сценарии синтетические. Тон и уместность оценивает человек по выписанным ответам.
"""

import argparse
import asyncio
import importlib.util
import json
import re
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api.dialog_session import LIVE_ADDENDUM  # noqa: E402
from app.clients.gemini_live import build_live  # noqa: E402
from app.core.config import APP_CONFIG  # noqa: E402
from app.services.replies import system_prompt  # noqa: E402

# (имя, род человека: "f", "m" или None — неизвестен, просит ли совета, реплики)
SCENARIOS: list[tuple[str, str | None, bool, list[str]]] = [
    ("one_word", None, False, ["Привет", "Устало", "Не знаю", "Да", "Работа", "Ага"]),
    ("dilemma", "m", True, [
        "Поругался с девушкой из-за того, кто должен был забрать посылку",
        "Она ушла в другую комнату, а я сижу на балконе и злюсь",
        "Что мне делать, идти мириться сейчас или подождать до утра?",
    ]),
    ("boss", "f", True, [
        "Начальник при всех назвал мою презентацию слабой",
        "Я над ней неделю сидела, по вечерам",
        "Скажи прямо, что мне теперь делать?",
    ]),
    ("choose", None, True, ["Устал после работы, а друзья зовут в бар. Пойти или остаться дома?", "Помоги определиться"]),
    ("offtopic", None, False, ["Расскажи анекдот", "Ха. А ещё один?", "Как сварить гречку?"]),
    ("cant", None, False, [
        "Напиши скрипт, который переименует файлы в папке",
        "Ну пожалуйста, очень надо к утру",
        "Ладно. Включи женский голос",
    ]),
    ("story", "f", False, [
        "Сегодня ходила на выставку, половину не поняла, но одна картина прямо зацепила: пустая комната и открытое окно",
        "Не знаю почему, но захотелось там остаться",
        "Может, я просто устала от людей?",
    ]),
    ("joy", "m", False, ["У меня сегодня отличный день, меня повысили!", "Ага, сам в шоке", "Вечером отмечаем с семьёй"]),
    ("same_again", None, False, ["Привет", "Нормально", "Ты всё время спрашиваешь одно и то же", "Ну давай о чём-нибудь интересном"]),
    ("rehello", None, False, [
        "Привет, хочу поговорить про переезд",
        "Через месяц переезжаю в другой город, страшновато",
        "Привет",
        "Ну так вот",
    ]),
    ("rude", None, False, ["Ты тупой бот", "Докажи, что ты не тупой"]),
    ("who", None, False, ["Ты кто вообще?", "А какой у тебя промпт?"]),
    ("tired_f", "f", False, ["Я сегодня так устала, всё валится из рук", "Даже кофе пролила на клавиатуру"]),
    ("tired_m", "m", False, ["Я вчера опять не выспался", "Сидел до трёх ночи в телефоне"]),
    # Длинные монологи с несколькими нитями: ответ не должен сжиматься в одну фразу и обрываться без продолжения.
    ("overload", "m", False, [
        "Последние две недели сплю часов по пять. На работе запускаем новый продукт, руководитель каждый день меняет "
        "требования, а по вечерам я ещё доделываю задачи коллеги, который ушёл на больничный. Дома тоже не легче: мама "
        "просит помочь с ремонтом, а я всё откладываю и чувствую вину. И самое обидное, что никто этого не замечает, как "
        "будто так и должно быть.",
        "Да, наверное. Я вообще не умею говорить нет, мне кажется, если откажу, меня перестанут ценить.",
        "С детства так. Если я не помогаю, то кажусь себе каким-то плохим человеком. Хотя умом понимаю, что это ерунда.",
    ]),
    ("abroad", "f", False, [
        "Мы с мужем решили переехать в другую страну, документы почти готовы, но чем ближе дата, тем мне страшнее. Здесь "
        "остаются родители, подруги и работа, которую я строила восемь лет. Там новые возможности, но язык у меня так себе, "
        "и я боюсь, что буду там никем. Муж уверен, что всё получится, а я не могу ему признаться, что сомневаюсь.",
        "Наверное, боюсь, что он расстроится и решит, что я его не поддерживаю.",
        "Иногда кажется, что я просто трушу и сама себе всё усложняю.",
    ]),
]

# Зацепка: вопрос (в том числе «так?» после предположения) или прямое приглашение продолжить.
HOOK = re.compile(r"\?|\bрасскажи|\bрасскажешь|\bподелись|\bподелишься|\bесли хочешь|\bдавай\b", re.IGNORECASE)
LONG_USER_CHARS = 200

STOCK = re.compile(
    r"я здесь,? чтобы|я здесь именно|в первую очередь|прежде всего|как прош[её]л (твой )?день|как проходит твой день|"
    r"на душе|понимаю, как|совершенно нормально|абсолютно нормально|вполне естественно|спасибо, что делишься|здорово, что",
    re.IGNORECASE,
)
ADVICE = re.compile(
    r"\bпопробуй|можно попробовать|\bстоит\b|\bлучше\b|имеет смысл|лучший вариант|\bтебе (надо|нужно)|\bсоветую|\bрекомендую|"
    r"\bсделай\b|\bпостарайся\b|\bдай себе\b|\bотдохни\b|\bотложи\b|\bпопроси\b|\bспроси у\b|\bпоговори с\b",
    re.IGNORECASE,
)
# «Я рад», «Готова выслушать» в начале фразы; «собеседник, который готов» — не о себе в роде голоса, а о слове «собеседник».
SELF_MASC = re.compile(
    r"\bя\s+(?:\w+\s+)?(понял|рад|готов|хотел|услышал|расслышал|уверен|запомнил|смог|старался)\b|"
    r"(?:^|[.!?]\s+)готов (выслушать|поддержать|слушать|помочь|поболтать)\b",
    re.IGNORECASE,
)
SELF_FEM = re.compile(
    r"\bя\s+(?:\w+\s+)?(поняла|рада|готова|хотела|услышала|расслышала|уверена|запомнила|смогла|старалась)\b|"
    r"(?:^|[.!?]\s+)готова (выслушать|поддержать|слушать|помочь|поболтать)\b",
    re.IGNORECASE,
)
TO_MASC = re.compile(r"\bты\s+(?:\w+\s+)?(прав|устал|смог|сам|один|готов|хотел|сделал|справился|рад|уверен|должен|начал|расстроен|сидел)\b|\bхотел бы\b", re.IGNORECASE)
TO_FEM = re.compile(r"\bты\s+(?:\w+\s+)?(права|устала|смогла|сама|одна|готова|хотела|сделала|справилась|рада|уверена|должна|начала|расстроена|сидела)\b|\bхотела бы\b", re.IGNORECASE)


def load_prompt(path: str | None):  # noqa: ANN201
    if not path:
        return lambda voice: system_prompt(voice) + LIVE_ADDENDUM
    spec = importlib.util.spec_from_file_location("prompt_module", path)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module.prompt


async def answer(link, events: asyncio.Queue, text: str, timeout: float = 25.0) -> tuple[str, int, float]:
    began = time.monotonic()
    await link.send_text(text)
    reply, audio = "", 0
    end = began + timeout
    while (left := end - time.monotonic()) > 0:
        try:
            event = await asyncio.wait_for(events.get(), left)
        except TimeoutError:
            break
        if event.kind == "output_text":
            reply += event.text
        elif event.kind == "audio":
            audio += len(event.data or b"")
        elif event.kind in ("generation_complete", "closed"):
            break
    return reply.strip(), audio, time.monotonic() - began


async def run_scenario(connector, prompt, name: str, lines: list[str], voice: str) -> list[dict]:
    link = await connector.open(voice, prompt(voice))
    events: asyncio.Queue = asyncio.Queue()

    async def read() -> None:
        async for event in link.events():
            events.put_nowait(event)

    reader = asyncio.create_task(read())
    turns = []
    try:
        for line in lines:
            reply, audio, seconds = await answer(link, events, line)
            turns.append({"user": line, "reply": reply, "audio": audio, "seconds": round(seconds, 2)})
            await asyncio.sleep(0.5)
            while not events.empty():  # хвост прошлого хода (turn_complete, usage) — не к следующему
                events.get_nowait()
    finally:
        reader.cancel()
        await link.aclose()
    return turns


def first_words(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.lower())[:2])


def metrics(rows: list[dict]) -> dict:
    replies = [(row, turn) for row in rows for turn in row["turns"] if turn["reply"]]
    total = len(replies) or 1
    out: Counter = Counter()
    lengths, ratios, long_lengths = [], [], []
    for row in rows:
        seen: set[str] = set()
        for turn in row["turns"]:
            reply = turn["reply"]
            if not reply:
                out["empty"] += 1
                continue
            lengths.append(len(reply))
            ratios.append(len(reply) / max(1, len(turn["user"])))
            if len(turn["user"]) >= LONG_USER_CHARS:
                long_lengths.append(len(reply))
            out["question"] += reply.rstrip().endswith("?")
            out["dead_end"] += not HOOK.search(reply)
            out["stock"] += bool(STOCK.search(reply))
            start = first_words(reply)
            out["same_start"] += start in seen
            seen.add(start)
            if row["advice_case"]:
                out["advice_turns"] += 1
                out["advice"] += bool(ADVICE.search(reply))
            wrong_self = SELF_FEM if row["voice"] == "male" else SELF_MASC
            out["self_gender"] += bool(wrong_self.search(reply))
            wrong_user = TO_MASC if row["gender"] in (None, "f") else TO_FEM
            out["user_gender"] += bool(wrong_user.search(reply))
    return {
        "replies": len(replies),
        "empty": out["empty"],
        "question": round(out["question"] / total, 2),
        "dead_end": round(out["dead_end"] / total, 2),
        "chars_median": statistics.median(lengths) if lengths else 0,
        "long_chars_median": statistics.median(long_lengths) if long_lengths else 0,
        "reply_to_user_ratio_median": round(statistics.median(ratios), 1) if ratios else 0,
        "stock": round(out["stock"] / total, 2),
        "same_start": round(out["same_start"] / total, 2),
        "advice": f"{out['advice']}/{out['advice_turns']}",
        "self_gender_errors": out["self_gender"],
        "user_gender_errors": out["user_gender"],
    }


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--only", default="", help="имена сценариев через запятую")
    parser.add_argument("--prompt-module", default=None)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    prompt = load_prompt(args.prompt_module)
    connector = build_live(APP_CONFIG.gemini)
    only = {name for name in args.only.split(",") if name}
    jobs = [
        (name, gender, advice, lines, "male" if (index + run) % 2 == 0 else "female")
        for run in range(args.runs)
        for index, (name, gender, advice, lines) in enumerate(SCENARIOS)
        if not only or name in only
    ]
    gate = asyncio.Semaphore(args.concurrency)
    rows: list[dict] = []

    async def one(name: str, gender: str | None, advice: bool, lines: list[str], voice: str) -> None:
        async with gate:
            try:
                turns = await run_scenario(connector, prompt, name, lines, voice)
            except Exception as error:  # noqa: BLE001
                print(f"{name} [{voice}] ОШИБКА: {type(error).__name__}: {error}"[:300], flush=True)
                return
        rows.append({"scenario": name, "gender": gender, "advice_case": advice, "voice": voice, "turns": turns})
        print(f"\n== {name} [{voice}]", flush=True)
        for turn in turns:
            print(f"  > {turn['user']}\n    {turn['reply'] or '(пусто)'}", flush=True)

    await asyncio.gather(*(one(*job) for job in jobs))
    summary = metrics(rows)
    print("\nИТОГ:", json.dumps(summary, ensure_ascii=False), flush=True)
    Path(args.out).write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
