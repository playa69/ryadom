"""Тексты и проверки агента, не зависящие от сокета: промпт, деление на предложения, чужой язык, эхо, тишина."""

import pytest

from app.api.dialog_live import is_silence
from app.services.replies import SYSTEM_PROMPT, is_echo, is_foreign_noise, split_sentences, take_sentences

# ─── Промпт: оффтоп, хорошее настроение, язык ─────────────────────────────────


def test_prompt_carries_the_offtopic_and_good_mood_rules():
    prompt = SYSTEM_PROMPT.lower()
    assert "рецептов" in prompt and "анекдот" in prompt  # оффтоп: по сути и коротко, без пошаговых инструкций
    assert "не переводи разговор насильно на чувства" in prompt  # и без обязательного возврата к «как прошёл день»
    assert "кстати, я здесь в первую очередь" not in prompt and "как прошёл твой день?" not in prompt  # образец копировался
    assert "погоду" in prompt and "скажи прямо" in prompt  # не выдумывает то, чего не знает
    assert "не ищи проблем" in prompt
    assert "эмодзи" in prompt
    # Язык: только русский; на просьбу переключиться агент отвечает, что поддерживает только русский.
    assert "говори только по-русски" in prompt and "поддерживаешь только русский" in prompt
    assert "на его языке" not in prompt  # прежнее правило «отвечай на языке человека» снято


def test_prompt_does_not_push_the_person_off_their_topic_or_into_a_language_lecture():
    """Жалобы по живому разговору: на «устала» (расшифровано как чужое слово) агент трижды читал лекцию про русский язык,
    на «не знаю» предлагал сменить тему, после ответа не по теме тянул к «как прошёл день»."""
    prompt = SYSTEM_PROMPT.lower()
    assert "прости, я пока говорю только по-русски" not in prompt  # готовой фразы-образца на любой непонятный ввод нет
    assert "короткое, тихое или неразборчивое слово" in prompt and "попроси повторить" in prompt
    assert "не говори человеку про язык, пока он сам об этом не заговорил" in prompt
    assert "на «не знаю» не меняй тему" in prompt
    assert "его тема и есть разговор" in prompt
    assert "не начинай сначала" in prompt  # человек снова поздоровался посреди разговора


def test_prompt_lets_the_model_adapt_to_the_person_instead_of_one_formula():
    """В проде 79% ответов кончались вопросом, ответ был в несколько раз длиннее реплики человека, каждый восьмой — с
    «я здесь, чтобы…»; люди жаловались на допрос и повторы. Формула «признай чувство + вопрос» и «одно-три предложения»
    убраны: длина, вопрос и форма — по собеседнику; советов нет, вместо них — помочь разобраться."""
    prompt = SYSTEM_PROMPT.lower()
    assert "подстраивайся под человека" in prompt and "не допрашивай" in prompt
    assert "избегай дежурных оборотов" in prompt and "не рассказывай о своей роли" in prompt
    assert "сначала признай чувство" not in prompt and "одно-три предложения" not in prompt
    # Живая проба первой версии: ответы сжимались ради краткости, и 6 из 11 кончались без продолжения — разговор тянул человек.
    assert "длина — по содержанию, а не по лимиту" in prompt and "три-пять предложений" in prompt
    assert "не длиннее" not in prompt and "просто коротко отзовись" not in prompt
    assert "за что зацепиться" in prompt and "тупик" in prompt  # у каждого ответа есть продолжение
    assert "глубже поверхности" in prompt and "не дежурное «как ты себя чувствуешь»" in prompt
    # Что делать: не советы (даже мягкие), а разбор — что задевает, что спорит, гипотеза, выбор за человеком.
    assert "не говори человеку, что ему делать" in prompt and "можно попробовать" in prompt
    assert "помоги разобраться" in prompt and "гипотезу" in prompt
    assert "две-три простые конкретные идеи" not in prompt
    # Род человека — по его словам, а не мужской по умолчанию; о себе — по голосу (`system_prompt`).
    assert "род человека бери из его собственных слов" in prompt and "не угадывай род собеседника" not in prompt
    # Чего агент не может — прямо; голос выбирают в профиле; на «кто ты» — честно про ИИ.
    assert "в профиле приложения" in prompt and "на основе ии" in prompt


# ─── Чужой язык вместо русского слова ─────────────────────────────────────────


@pytest.mark.parametrize(
    "heard, noise",
    [
        ("usted", True),  # расшифровка настоящего слова «устала» из живого разговора
        ("gustaba", True),
        ("gustala gustala ya gustala", True),  # «устала устала я устала»: четыре слова
        ("el primer", True),  # «например»
        ("ok", True),
        ("你好", True),
        ("устала", False),
        ("я устала после work", False),  # русские буквы есть
        ("I want to talk about my day today", False),  # целая фраза: до модели, ответ по правилу про язык
        ("I'm so tired today.", False),  # короткая, но настоящая английская речь (живая проверка): не шум
        ("english please", False),
        ("gustar", True),
        ("...", False),  # нет букв: не чужой язык
        ("123", False),
    ],
)
def test_foreign_noise_is_a_few_words_without_russian_letters(heard, noise):
    assert is_foreign_noise(heard) is noise


# ─── Предложения ──────────────────────────────────────────────────────────────


def test_a_sentence_at_the_end_of_the_buffer_waits_for_what_may_follow():
    assert take_sentences("Привет. Как", final=False) == (["Привет."], " Как")
    assert take_sentences("Привет.", final=False) == ([], "Привет.")  # за точкой может прийти «..» или «?!»
    assert take_sentences("Привет.", final=True) == (["Привет."], "")
    assert take_sentences("Привет. Как дела", final=True) == (["Привет.", "Как дела"], "")


def test_decimals_ellipsis_and_exclamations_do_not_split_wrongly():
    assert take_sentences("Это 3.5 часа. Да.", final=True)[0] == ["Это 3.5 часа.", "Да."]
    assert take_sentences("Что?! Да… Ну ладно.", final=True)[0] == ["Что?!", "Да…", "Ну ладно."]
    assert split_sentences("Я рядом. С чего начнём?") == ["Я рядом.", "С чего начнём?"]
    assert split_sentences("  ") == []


# ─── Эхо и тишина ─────────────────────────────────────────────────────────────


def test_echo_is_the_agents_own_words_and_not_a_person_repeating_one_phrase():
    spoken = "Я слышу тебя. Расскажи, что у тебя на душе?"
    assert is_echo("расскажи что у тебя на душе", spoken)
    assert not is_echo("мне сегодня очень тяжело", spoken)
    assert not is_echo("на душе", spoken)  # слишком коротко, чтобы судить
    assert not is_echo("расскажи что у тебя на душе", "")


@pytest.mark.parametrize(
    ("pcm", "silent"),
    [(b"", True), (bytes(3200), True), (b"\x01\x00" * 1600, True), (b"\xb8\x0b" * 1600, False)],
)
def test_is_silence(pcm, silent):
    assert is_silence(pcm) is silent
