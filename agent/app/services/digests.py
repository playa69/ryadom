"""Итоги недели и года по отметкам настроения (add-mood-diary, D6): текст пишет модель, агент ничего не хранит.

В модель уходят только коды отметок (уровень 1–5, фактор) и тексты прошлых итогов недель, без имени и почты. Запрос и ответ
не пишутся в журнал. Ответ модели проверяется (`clean_digest`); если в нём «надо», среднее число, счёт дней подряд или он
не укладывается в длину, вместо него возвращается шаблонный текст — так же отвечает режим `LLM_MODE=template`.

Прямых цитат нет: итог — обобщение своими словами. Из ответа отбраковываются слова в кавычках длиннее двух слов и дословные
куски (шесть слов подряд) из текстов, которые человек сам сказал (`source_texts`: итоги разговоров и заметки, когда они
подключатся из `add-memory-notes`; пока агент получает только отметки и прошлые итоги недель, и список пуст).
"""

import re
from collections import Counter
from typing import Any, Literal

LEVELS = {1: "тяжело", 2: "так себе", 3: "нормально", 4: "хорошо", 5: "отлично"}
FACTORS = {"work": "работа", "people": "близкие", "health": "здоровье", "money": "деньги", "sleep": "сон"}

# Неделя: 4–6 предложений, год — до 12.
WEEK_SENTENCES = (4, 6)
YEAR_SENTENCES_MAX = 12
HARD_WEEK_DAYS = 3

PEOPLE_LINE = "Если сейчас непросто, рядом могут быть люди, с которыми можно поговорить, и я тоже здесь."

SYSTEM_PROMPT = (
    "Ты — Рядом, тёплый голосовой спутник для эмоциональной поддержки. Напиши человеку итоги по его отметкам настроения. "
    "Обращайся на «ты». Не оценивай человека, не ставь диагнозов, не давай советов со словом «надо» и «должен», "
    "не считай дни подряд, не называй средний балл числом. Не цитируй слова человека и тексты его разговоров ни в кавычках, ни дословно: "
    "только обобщение своими словами. Пиши спокойно и бережно, без восклицательных знаков и без эмодзи. "
    "Уровни: 1 — тяжело, 2 — так себе, 3 — нормально, 4 — хорошо, 5 — отлично."
)

_FORBIDDEN = re.compile(r"\b(надо|должен|должна|нужно)\b", re.IGNORECASE)
_AVERAGE = re.compile(r"средн\w*\s+(балл|оценк|значени|уровен)|\d+[.,]\d+\s*(из|/)\s*5|\b\d+\s*/\s*5\b", re.IGNORECASE)
_STREAK = re.compile(r"\b(подряд|серия|серию|серии|без пропусков)\b", re.IGNORECASE)
_SENTENCE_END = re.compile(r"[.!?…]+(?:\s+|$)")
# Слова в кавычках: «…», "…", „…“, “…”. Одно-два слова в кавычках (названия уровней, тем) допустимы, длиннее — цитата.
_QUOTED = re.compile(r"«([^»]*)»|\"([^\"]*)\"|„([^“”\"]*)[“”\"]|“([^”]*)”")
_WORDS = re.compile(r"\w+", re.UNICODE)
QUOTE_MAX_WORDS = 2
VERBATIM_WORDS = 6


def stats_of(marks: list[dict[str, Any]]) -> dict[str, Any]:
    """Сводка для приложения: сколько дней отмечено, сколько «тяжело», самый частый уровень (при равенстве — выше)."""
    counts = Counter(m["mood"] for m in marks)
    most = max(counts, key=lambda level: (counts[level], level)) if counts else None
    return {"markedDays": len(marks), "hardDays": counts.get(1, 0), "mostFrequent": most}


def sentence_count(text: str) -> int:
    return len([part for part in _SENTENCE_END.split(text.strip()) if part.strip()])


def _top_factor(marks: list[dict[str, Any]]) -> str | None:
    factors = Counter(m["factor"] for m in marks if m.get("factor"))
    return FACTORS.get(factors.most_common(1)[0][0]) if factors else None


def template_digest(kind: Literal["week", "year"], marks: list[dict[str, Any]], weekly: list[str]) -> str:
    """Детерминированный текст без модели: для `LLM_MODE=template` и как запасной вариант при забракованном ответе."""
    stats = stats_of(marks)
    top = LEVELS.get(stats["mostFrequent"] or 3, "нормально")
    factor = _top_factor(marks)
    parts: list[str]
    if kind == "week":
        parts = [
            "Эта неделя прошла рядом с тобой, и я рад, что ты находил минутку отметить, как ты.",
            f"Чаще всего ты отмечал, что тебе {top}.",
        ]
        parts.append(f"Больше всего на настроение влияло: {factor}." if factor else "Что именно влияло, ты почти не отмечал, и это тоже нормально.")
        parts.append("Дни бывают разными, и в каждом из них ты был настоящим.")
        if stats["hardDays"] >= HARD_WEEK_DAYS:
            parts.append(PEOPLE_LINE)
    else:
        parts = [
            "Этот год ты отмечал своё настроение и этим уделял себе внимание.",
            f"Чаще всего тебе было {top}.",
        ]
        if factor:
            parts.append(f"Заметнее всего на настроение влияло: {factor}.")
        if weekly:
            parts.append("Из итогов недель складывается история, где были и тихие дни, и более яркие.")
        parts.append("Я рад, что был рядом в эти дни, и буду рядом дальше.")
        if stats["hardDays"] >= HARD_WEEK_DAYS:
            parts.append(PEOPLE_LINE)
    return " ".join(parts)


def build_messages(kind: Literal["week", "year"], period_start: str, marks: list[dict[str, Any]], weekly: list[str]) -> list[dict[str, str]]:
    lines = [f"{m['date']}: {m['mood']}" + (f", фактор: {FACTORS[m['factor']]}" if m.get("factor") else "") for m in marks]
    if kind == "week":
        task = (
            f"Итоги недели с {period_start}. Напиши {WEEK_SENTENCES[0]}–{WEEK_SENTENCES[1]} предложений: как прошла неделя по отметкам "
            "(без среднего балла цифрами), что чаще всего влияло, одно наблюдение без оценки и советов. Без цитат: только обобщение."
        )
        if stats_of(marks)["hardDays"] >= HARD_WEEK_DAYS:
            task += " Закончи мягкой строкой про людей рядом."
        body = task + "\nОтметки:\n" + "\n".join(lines)
    else:
        task = (
            f"История года, начиная с {period_start}. Напиши до {YEAR_SENTENCES_MAX} предложений: как менялось настроение по сезонам, "
            "что помогало, к чему человек пришёл. Без цитат: только обобщение."
        )
        body = task + "\nОтметки:\n" + "\n".join(lines)
        if weekly:
            body += "\nПрошлые итоги недель:\n" + "\n".join(f"- {text}" for text in weekly)
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": body}]


def has_quotation(text: str, source_texts: list[str] | None = None) -> bool:
    """Есть ли в тексте цитата: слова в кавычках длиннее двух слов или шесть слов подряд, взятые дословно из `source_texts`."""
    for match in _QUOTED.finditer(text):
        quoted = next((group for group in match.groups() if group is not None), "")
        if len(_WORDS.findall(quoted)) > QUOTE_MAX_WORDS:
            return True
    if source_texts:
        words = [w.lower() for w in _WORDS.findall(text)]
        grams = {tuple(words[i : i + VERBATIM_WORDS]) for i in range(len(words) - VERBATIM_WORDS + 1)}
        for source in source_texts:
            source_words = [w.lower() for w in _WORDS.findall(source)]
            if any(tuple(source_words[i : i + VERBATIM_WORDS]) in grams for i in range(len(source_words) - VERBATIM_WORDS + 1)):
                return True
    return False


def clean_digest(
    kind: Literal["week", "year"], text: str, marks: list[dict[str, Any]], source_texts: list[str] | None = None
) -> str | None:
    """Ответ модели, если он годится, иначе None (тогда подставляется шаблон)."""
    text = " ".join(text.split())
    if not text or _FORBIDDEN.search(text) or _AVERAGE.search(text) or _STREAK.search(text):
        return None
    if has_quotation(text, source_texts):
        return None
    count = sentence_count(text)
    low, high = WEEK_SENTENCES if kind == "week" else (1, YEAR_SENTENCES_MAX)
    if count < low or count > high:
        return None
    if stats_of(marks)["hardDays"] >= HARD_WEEK_DAYS and not re.search(r"рядом|близк|люд", text, re.IGNORECASE):
        text = f"{text} {PEOPLE_LINE}"
        if kind == "week" and sentence_count(text) > WEEK_SENTENCES[1]:
            return None
    return text
