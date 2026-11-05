"""Проверки агента, не зависящие от сокета: предложения, чужой язык, эхо и тишина."""

import pytest

from app.api.dialog_session import is_silence
from app.services.replies import is_echo, is_foreign_noise, split_sentences, take_sentences


@pytest.mark.parametrize(
    "heard, noise",
    [
        ("usted", True),
        ("gustaba", True),
        ("gustala gustala ya gustala", True),
        ("el primer", True),
        ("ok", True),
        ("你好", True),
        ("устала", False),
        ("я устала после work", False),
        ("I want to talk about my day today", False),
        ("I'm so tired today.", False),
        ("english please", False),
        ("gustar", True),
        ("...", False),
        ("123", False),
    ],
)
def test_foreign_noise_is_a_few_words_without_russian_letters(heard, noise):
    """Короткая бессмысленная расшифровка отличается от настоящей иностранной речи."""
    assert is_foreign_noise(heard) is noise


def test_a_sentence_at_the_end_of_the_buffer_waits_for_what_may_follow():
    """Незавершённая фраза не уходит в озвучку раньше времени."""
    assert take_sentences("Привет. Как", final=False) == (["Привет."], " Как")
    assert take_sentences("Привет.", final=False) == ([], "Привет.")
    assert take_sentences("Привет.", final=True) == (["Привет."], "")
    assert take_sentences("Привет. Как дела", final=True) == (["Привет.", "Как дела"], "")


def test_decimals_ellipsis_and_exclamations_do_not_split_wrongly():
    """Числа и многоточия не ломают деление на предложения."""
    assert take_sentences("Это 3.5 часа. Да.", final=True)[0] == ["Это 3.5 часа.", "Да."]
    assert take_sentences("Что?! Да… Ну ладно.", final=True)[0] == ["Что?!", "Да…", "Ну ладно."]
    assert split_sentences("Я рядом. С чего начнём?") == ["Я рядом.", "С чего начнём?"]
    assert split_sentences("  ") == []


def test_echo_is_the_agents_own_words_and_not_a_person_repeating_one_phrase():
    """Эхо определяется только по длинному совпадению с ответом агента."""
    spoken = "Я слышу тебя. Расскажи, что у тебя на душе?"
    assert is_echo("расскажи что у тебя на душе", spoken)
    assert not is_echo("мне сегодня очень тяжело", spoken)
    assert not is_echo("на душе", spoken)
    assert not is_echo("расскажи что у тебя на душе", "")


@pytest.mark.parametrize(
    ("pcm", "silent"),
    [(b"", True), (bytes(3200), True), (b"\x01\x00" * 1600, True), (b"\xb8\x0b" * 1600, False)],
)
def test_is_silence(pcm, silent):
    """Тишина определяется по амплитуде PCM."""
    assert is_silence(pcm) is silent
