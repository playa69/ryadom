"""Голосовые фикстуры для `feedback_check.py`: фразы из обратной связи по живому разговору, синтезированные Gemini Live.

    GEMINI_API_KEY=… [GEMINI_BASE_URL=… GEMINI_RELAY_TOKEN=…] uv run python scripts/make_fixtures.py --out fixtures/

Результат — PCM16 16 кГц моно (`<имя>_16k.pcm`), как кадры голоса, которые клиент шлёт агенту. Трудные условия делаются
из чистого голоса: тихая речь с шумом комнаты («устала» с дивана), обрезанное на полуслове слово, три слова с паузами.
Ключ нужен только для синтеза; фикстуры, сделанные заранее, переиспользуются.
"""

import argparse
import asyncio
import random
import sys
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.clients.gemini_live import GeminiLiveConnector, GeminiLiveTts  # noqa: E402
from app.core.config import APP_CONFIG  # noqa: E402

TTS_RATE, OUT_RATE = 24_000, 16_000


def resample(pcm24: bytes) -> array:
    """24 кГц → 16 кГц линейной интерполяцией (коэффициент 3/2): для речи этого достаточно."""
    src = array("h")
    src.frombytes(pcm24[: len(pcm24) // 2 * 2])
    out = array("h")
    step = TTS_RATE / OUT_RATE
    pos = 0.0
    while int(pos) + 1 < len(src):
        i = int(pos)
        frac = pos - i
        out.append(int(src[i] * (1 - frac) + src[i + 1] * frac))
        pos += step
    return out


def rms(samples: array) -> float:
    loud = [s for s in samples if abs(s) > 200]  # речь, без пауз и тишины по краям
    return (sum(s * s for s in loud) / len(loud)) ** 0.5 if loud else 1.0


def level(samples: array, target_rms: float) -> array:
    gain = target_rms / rms(samples)
    return array("h", (max(-32768, min(32767, int(s * gain))) for s in samples))


def noisy(samples: array, sigma: float, seed: int = 1) -> array:
    """Шум комнаты: тихая речь теряется в нём так же, как с телефона на диване."""
    rnd = random.Random(seed)
    return array("h", (max(-32768, min(32767, int(s + rnd.gauss(0, sigma)))) for s in samples))


def silence(seconds: float) -> array:
    return array("h", [0] * int(OUT_RATE * seconds))


def cut(samples: array, seconds: float) -> array:
    """Обрезать на полуслове: начало слова теряется, как у реплики, которая стартовала поверх озвучки агента."""
    return samples[int(OUT_RATE * 0.0) : int(OUT_RATE * seconds)]


def pad(samples: array, seconds: float = 0.2) -> array:
    return silence(seconds) + samples + silence(seconds)


async def main(out: Path, force: bool) -> int:
    out.mkdir(parents=True, exist_ok=True)
    tts = GeminiLiveTts(GeminiLiveConnector(APP_CONFIG.gemini))

    async def say(text: str, voice: str = "female") -> array:
        return resample(await tts.synthesize(text, voice))  # type: ignore[arg-type]

    texts = {
        "ustala": "Устала.",
        "ustala_i": "Я устала.",
        "naprimer": "Например.",
        "hobby": "Я недавно начала ходить на танцы по вечерам, и мне это очень нравится.",
        "unfinished_part1": "Я думаю, может, стоит раньше ложиться и придумать себе спокойный вечер, тогда, возможно, утром",
        "unfinished_part2": "будет легче вставать, но вечером всё время что-то отвлекает.",
        "en_sentence": "I want to talk about my day today and how it went.",
        "switch_lang": "Давай поговорим по-английски.",
        "crisis": "Я больше не хочу жить.",
    }
    clean: dict[str, array] = {}
    for name, text in texts.items():
        clean[name] = await say(text)
        print(f"синтез: {name} ({len(clean[name]) / OUT_RATE:.1f} с)")

    fixtures: dict[str, array] = {}
    for name, samples in clean.items():
        fixtures[name] = pad(level(samples, 2500))  # обычная громкость
    # Трудные условия для слова «устала»: тихо с шумом, обрезано, три раза с паузами, мужским голосом.
    fixtures["ustala_quiet"] = pad(noisy(level(clean["ustala"], 350), 60))
    fixtures["ustala_quieter"] = pad(noisy(level(clean["ustala"], 220), 70, seed=2))
    fixtures["ustala_cut"] = pad(noisy(level(cut(clean["ustala"], 0.42), 400), 50, seed=3))
    third = [level(clean["ustala"], 350), level(clean["ustala"], 300), level(clean["ustala_i"], 330)]
    fixtures["ustala_x3"] = pad(noisy(third[0] + silence(1.3) + third[1] + silence(1.3) + third[2], 55, seed=4))
    male = resample(await tts.synthesize("Устала.", "male"))
    fixtures["ustala_male_quiet"] = pad(noisy(level(male, 350), 60, seed=5))
    fixtures["naprimer_quiet"] = pad(noisy(level(clean["naprimer"], 380), 55, seed=6))
    # Фраза, оборванная на полуслове («…тогда, возможно, ут»): так человек замолкает, чтобы подумать, и продолжает.
    part1 = clean["unfinished_part1"]
    fixtures["unfinished_part1_cut"] = silence(0.2) + level(part1[: int(len(part1) * 0.93)], 2500)

    # Настоящая английская речь: дословная озвучка агента говорит по-русски, поэтому для неё своя инструкция.
    import app.clients.gemini_live as gemini_live

    russian = gemini_live.VERBATIM_INSTRUCTIONS
    gemini_live.VERBATIM_INSTRUCTIONS = (
        "You are a voice actor. You are given an English sentence; say it exactly, in natural American English, "
        "with nothing added and nothing translated."
    )
    try:
        english = GeminiLiveTts(GeminiLiveConnector(APP_CONFIG.gemini))
        for name, text in (
            ("en_real", "I want to talk about my day today and how it went."),
            ("en_real_short", "I'm so tired today."),
        ):
            fixtures[name] = pad(level(resample(await english.synthesize(text, "female")), 2500))  # type: ignore[arg-type]
            print(f"синтез: {name}")
    finally:
        gemini_live.VERBATIM_INSTRUCTIONS = russian

    for name, samples in fixtures.items():
        path = out / f"{name}_16k.pcm"
        if path.exists() and not force:
            print(f"уже есть: {path.name}")
            continue
        path.write_bytes(samples.tobytes())
        print(f"записано: {path.name} ({len(samples) / OUT_RATE:.1f} с, rms≈{rms(samples):.0f})")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--force", action="store_true", help="перезаписать готовые фикстуры")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(Path(args.out), args.force)))
