"""Тексты агента: системный промпт и правила памяти для Gemini Live, фиксированные фразы и проверки реплик.

Шаблонов вместо ответа модели нет: не зная сказанного, они звучали невпопад. Фиксированные фразы — только кризисный ответ,
просьба повторить и приветствия (app/services/dialog_store.py). Кризис определяется по списку слов и отвечает фиксированным
текстом, модель в этот путь не входит.
"""

import re
from difflib import SequenceMatcher

from app.services import crisis_script
from app.services.crisis import classify_words

# Расшифровка голоса оказалась обрывком чужого языка («usted»): агент не отвечает по ней, а просит повторить.
REPEAT_REQUEST = "Прости, плохо слышно. Повтори, пожалуйста?"

# Кризисная ветка целиком — app/services/crisis.py, тексты — app/services/crisis_script.py.
CRISIS_REPLY = crisis_script.RED_FIRST
CRISIS_SAFETY_TEXT = crisis_script.SHEET_TITLE


def is_crisis(text: str) -> bool:
    """Красные слова в реплике (первая ступень детектора)."""
    return classify_words(text) == "red"


NOISE_MAX_WORDS = 5  # «gustala gustala ya gustala» из живого разговора — четыре слова
NOISE_CHECK_CHARS = 55  # сколько текста ответа ждём, прежде чем решить, что это не лекция про язык

# Ответ про язык: «я говорю только по-русски», «давай на русском», «поддерживаю только русский язык».
_LANGUAGE_LECTURE = re.compile(r"по-русски|на русском|только русск|русск\w+ язык|на другом языке|другом языке", re.IGNORECASE)


def is_language_lecture(answer: str) -> bool:
    return _LANGUAGE_LECTURE.search(answer) is not None


# Буквы письменностей, на которых агент не говорит: голосовая модель изредка вставляет в русскую речь чужое слово
# («усталость бывает很 тяжелой»). Латиница сюда не входит: «ок», названия и имена по-латински бывают в обычной речи.
_FOREIGN_SCRIPT = re.compile(
    "["
    "֐-׿"  # иврит
    "؀-ۿݐ-ݿ"  # арабское письмо
    "ऀ-෿"  # индийские письменности
    "฀-๿"  # тайское
    "ᄀ-ᇿ㄰-㆏가-힯"  # хангыль
    "぀-ヿㇰ-ㇿｦ-ﾝ"  # кана
    "㐀-䶿一-鿿豈-﫿"  # иероглифы
    "　-〿！-／"  # иероглифическая пунктуация
    "]+"
)


def strip_foreign_script(text: str) -> tuple[str, int]:
    """Текст ответа без букв чужих письменностей (и сколько их было): в ленту и в историю они не попадают."""
    cleaned, count = _FOREIGN_SCRIPT.subn("", text)
    return cleaned, count


# Частые английские слова: короткая фраза с ними — настоящая английская речь («I'm so tired today»), а не обрывок русского
# слова. Испанские «no», «me», «a», «el» сюда нарочно не входят: в обрывках они и встречаются («el primer» вместо «например»).
_ENGLISH_WORDS = frozenset(
    "i im you your we they he she it its the to is am are was be have do dont can not and but of for with what how why "
    "today want talk speak english please hello hi yes feel tired day my so very really just like know think".split()
)


def is_foreign_noise(heard: str) -> bool:
    """Расшифровка голоса — до пяти слов без единой русской буквы и без узнаваемых английских слов («usted», «gustala
    gustala ya gustala»): не речь на другом языке, а плохо расслышанное русское слово. Целая фраза на другом языке и
    короткая английская фраза сюда не попадают: они дойдут до модели и получат ответ по правилу про язык в промпте."""
    words = re.findall(r"[^\W\d_]+", heard)
    if not words or len(words) > NOISE_MAX_WORDS:
        return False
    if re.search(r"[А-Яа-яЁё]", "".join(words)):
        return False
    return not any(word.lower() in _ENGLISH_WORDS for word in words)


# Конец предложения: знаки, возможные закрывающие кавычки и скобки, и сразу за ними пробел или конец текста.
# «3.5» и «т.е.» без пробела за точкой предложение не заканчивают.
_SENTENCE_END = re.compile(r"[.!?…]+[»\"')\]]*(?=\s|$)")


def take_sentences(buffer: str, final: bool = False) -> tuple[list[str], str]:
    """Готовые предложения из накопленного текста и остаток.

    Пока текст пишется (`final=False`), предложение, которое упирается в конец буфера, не отдаётся: за точкой ещё
    может прийти «..» или «?!». `final=True` отдаёт и недописанный хвост.
    """
    sentences: list[str] = []
    start = 0
    for match in _SENTENCE_END.finditer(buffer):
        if match.end() == len(buffer) and not final:
            break
        sentence = buffer[start : match.end()].strip()
        if sentence:
            sentences.append(sentence)
        start = match.end()
    rest = buffer[start:]
    if final:
        if rest.strip():
            sentences.append(rest.strip())
        rest = ""
    return sentences, rest


def split_sentences(text: str) -> list[str]:
    """Предложения для озвучки: первое звучит, пока остальные ещё синтезируются."""
    return take_sentences(text, final=True)[0]


def is_echo(heard: str, spoken: str) -> bool:
    """Распознанное — это слова самого агента, пойманные микрофоном: подряд идёт не меньше 80% услышанного.

    Нужно только для реплик, начатых поверх озвучки (перебивание): там динамик и слышит микрофон.
    """
    heard_words = re.findall(r"\w+", heard.lower())
    spoken_words = re.findall(r"\w+", spoken.lower())
    if len(heard_words) < 3 or not spoken_words:
        return False
    run = SequenceMatcher(None, heard_words, spoken_words, autojunk=False).find_longest_match(
        0, len(heard_words), 0, len(spoken_words)
    )
    return run.size / len(heard_words) >= 0.8
