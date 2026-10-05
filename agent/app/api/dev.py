"""Dev-эндпоинт проверки озвучки. Не входит в контракт agent-api.

`GET /dev/tts?text=Привет` отдаёт WAV (24 кГц, PCM16): послушать голос агента можно без приложения.
Требует тот же внутренний токен, что и /v1.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from app.api.deps import get_tts, require_token
from app.clients.speech import TextToSpeech, TtsError, pcm_to_wav
from app.core.errors import AgentError
from app.services.replies import split_sentences

router = APIRouter(dependencies=[Depends(require_token)])


@router.get("/dev/tts")
async def say(
    text: Annotated[str, Query(min_length=1, max_length=500)],
    tts: Annotated[TextToSpeech | None, Depends(get_tts)],
) -> Response:
    if tts is None:
        raise AgentError(503, "VOICE_UNAVAILABLE", "Озвучка не настроена: нет ключа SaluteSpeech и espeak-ng")
    try:
        pcm = b"".join([await tts.synthesize(sentence) for sentence in split_sentences(text) or [text]])
    except TtsError as error:
        raise AgentError(503, "VOICE_UNAVAILABLE", str(error)) from error
    return Response(pcm_to_wav(pcm), media_type="audio/wav", headers={"X-Tts-Provider": tts.name})
