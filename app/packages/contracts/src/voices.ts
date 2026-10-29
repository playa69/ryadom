/**
 * The agent's voices: the Gemini Live prebuilt voices (`id`, the name Google gives them and the agent sends
 * to Gemini) with the name the person sees (`name`) and the gender of the voice. The gender follows Google's
 * description of each voice and has not been checked by ear.
 *
 * The agent keeps the same list (`agent/app/core/voices.py`): a voice it does not know is refused.
 */
export type VoiceGender = 'male' | 'female'

/**
 * The voice path conversations start on, chosen in the admin console: `sber` (GigaASR, GigaChat and SaluteSpeech on
 * the model proxy) or `gemini` (Gemini Live). The values are stored in the app database and sent to the agent.
 */
export const VOICE_PIPELINES = ['sber', 'gemini'] as const
export type VoicePipeline = (typeof VOICE_PIPELINES)[number]

export interface VoiceOption {
  /** The provider's voice name: what the profile stores and the agent uses; the sample is `voice-samples/<id>.mp3`. */
  id: string
  /** The name shown to the person. */
  name: string
  gender: VoiceGender
}

export const FEMALE_VOICES: readonly VoiceOption[] = [
  { id: 'Kore', name: 'Мария', gender: 'female' },
  { id: 'Zephyr', name: 'Алиса', gender: 'female' },
  { id: 'Leda', name: 'Полина', gender: 'female' },
  { id: 'Aoede', name: 'Анна', gender: 'female' },
  { id: 'Callirrhoe', name: 'Елена', gender: 'female' },
  { id: 'Autonoe', name: 'Ольга', gender: 'female' },
  { id: 'Despina', name: 'Дарья', gender: 'female' },
  { id: 'Erinome', name: 'Ирина', gender: 'female' },
  { id: 'Laomedeia', name: 'Светлана', gender: 'female' },
  { id: 'Achernar', name: 'Наталья', gender: 'female' },
  { id: 'Gacrux', name: 'Татьяна', gender: 'female' },
  { id: 'Pulcherrima', name: 'Виктория', gender: 'female' },
  { id: 'Vindemiatrix', name: 'Екатерина', gender: 'female' },
  { id: 'Sulafat', name: 'София', gender: 'female' },
]

export const MALE_VOICES: readonly VoiceOption[] = [
  { id: 'Charon', name: 'Дмитрий', gender: 'male' },
  { id: 'Puck', name: 'Артём', gender: 'male' },
  { id: 'Fenrir', name: 'Максим', gender: 'male' },
  { id: 'Orus', name: 'Сергей', gender: 'male' },
  { id: 'Enceladus', name: 'Андрей', gender: 'male' },
  { id: 'Iapetus', name: 'Иван', gender: 'male' },
  { id: 'Umbriel', name: 'Михаил', gender: 'male' },
  { id: 'Algieba', name: 'Александр', gender: 'male' },
  { id: 'Algenib', name: 'Николай', gender: 'male' },
  { id: 'Rasalgethi', name: 'Павел', gender: 'male' },
  { id: 'Alnilam', name: 'Егор', gender: 'male' },
  { id: 'Schedar', name: 'Владимир', gender: 'male' },
  { id: 'Achird', name: 'Кирилл', gender: 'male' },
  { id: 'Zubenelgenubi', name: 'Алексей', gender: 'male' },
  { id: 'Sadachbia', name: 'Илья', gender: 'male' },
  { id: 'Sadaltager', name: 'Фёдор', gender: 'male' },
]

export const AGENT_VOICE_OPTIONS: readonly VoiceOption[] = [...FEMALE_VOICES, ...MALE_VOICES]

/** The voice a gender gets until the person picks another one (what the agent used before the choice existed). */
export const DEFAULT_VOICE_ID: Record<VoiceGender, string> = { male: 'Charon', female: 'Kore' }

/**
 * The one voice of the Sber path (SaluteSpeech on the model proxy has no other): it speaks whatever voice the person
 * chose, so the profile shows it instead of the choice while conversations start on that path.
 */
export const SBER_VOICE: VoiceOption = { id: 'Bab-Freespeech', name: 'Вера', gender: 'female' }

/** A Gemini Live voice by `id`: the only voices a person can choose and the profile stores. */
export function findVoice(id: string | null | undefined): VoiceOption | undefined {
  return AGENT_VOICE_OPTIONS.find((voice) => voice.id === id)
}
