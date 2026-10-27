/**
 * The agent's voices: the Gemini Live prebuilt voices (`id`, the name Google gives them and the agent sends
 * to Gemini) with the name the person sees (`name`) and the gender of the voice. The gender follows Google's
 * description of each voice and has not been checked by ear.
 *
 * The agent keeps the same list (`agent/app/core/voices.py`): a voice it does not know is refused.
 */
export type VoiceGender = 'male' | 'female'

export interface VoiceOption {
  /** Gemini voice name, the value the profile stores and the agent uses. */
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

export function findVoice(id: string | null | undefined): VoiceOption | undefined {
  return AGENT_VOICE_OPTIONS.find((voice) => voice.id === id)
}
