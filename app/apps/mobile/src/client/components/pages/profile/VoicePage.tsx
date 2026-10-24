import { Button, Icon, Link, List, ListItem, Navbar, Page, Segmented, f7 } from 'framework7-react'
import { useEffect, useState } from 'react'
import { playVoiceSample, stopVoiceSample } from '@ryadom/client-core/voice-sample'
import { DEFAULT_AGENT_VOICE, type AgentVoice } from '@ryadom/contracts/api/auth/me'
import { DEFAULT_VOICE_ID, FEMALE_VOICES, MALE_VOICES, findVoice } from '@ryadom/contracts/voices'
import { apiErrorText, updateProfile } from '../../../lib/api'
import { useAuth } from '../../../lib/store'

type Tab = 'female' | 'male'
const TABS: { id: Tab; label: string }[] = [
  { id: 'female', label: 'Женские' },
  { id: 'male', label: 'Мужские' },
]

/**
 * Выбор голоса агента (PROTEUS-182): отдельная страница профиля. Голоса сгруппированы по
 * полу, каждый можно послушать (▶) до выбора; тап по строке выбирает и сразу сохраняет. Голос сохраняется в аккаунте и следует за человеком на другое устройство.
 */
export default function VoicePage({ f7router }: { f7router: { back: () => void } }) {
  const { auth, updateUser } = useAuth()
  const user = auth.user
  const gender: AgentVoice = user?.voice ?? DEFAULT_AGENT_VOICE
  // The voice is on the account; until the person picks one, the default of the gender speaks.
  const savedId = user?.voiceName ?? DEFAULT_VOICE_ID[gender]
  const [draft, setDraft] = useState(savedId)
  const [tab, setTab] = useState<Tab>(findVoice(savedId)?.gender ?? 'male')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => stopVoiceSample, [])

  function toggle(id: string) {
    if (playingId === id) return stopVoiceSample()
    setPlayingId(id)
    playVoiceSample(id, () => setPlayingId((now) => (now === id ? null : now)))
  }

  // A tap on a row chooses and saves at once (the system pattern for a list of options); ▶ only plays the sample.
  async function choose(id: string) {
    if (id === draft || saving) return
    const previous = draft
    stopVoiceSample()
    setDraft(id)
    setSaving(true)
    try {
      const me = await updateProfile({ voiceName: id })
      updateUser({ voice: me.voice, voiceName: me.voiceName })
      f7.toast.create({ text: 'Голос сохранён', closeTimeout: 1500 }).open()
    } catch (error: unknown) {
      setDraft(previous)
      f7.toast
        .create({ text: apiErrorText(error, {}, 'Не получилось сохранить голос'), closeTimeout: 2500 })
        .open()
    } finally {
      setSaving(false)
    }
  }

  // An array of ListItem, not a fragment: Framework7's List wraps direct ListItem children in <ul>, and without it the <li> get bullets.
  const rows = (list: readonly { id: string; name: string }[]) =>
    list.map((v) => (
      <ListItem
        key={v.id}
        radio
        radioIcon="end"
        title={v.name}
        name="voice"
        value={v.id}
        checked={draft === v.id}
        onChange={() => void choose(v.id)}
        data-testid={`voice-${v.id}`}
      >
        <Link
          slot="media"
          iconOnly
          aria-label={`${playingId === v.id ? 'Остановить' : 'Прослушать'}: ${v.name}`}
          onClick={(e: { preventDefault: () => void; stopPropagation: () => void }) => {
            e.preventDefault()
            e.stopPropagation()
            toggle(v.id)
          }}
        >
          <Icon f7={playingId === v.id ? 'stop_circle_fill' : 'play_circle_fill'} size={28} />
        </Link>
      </ListItem>
    ))

  return (
    <Page name="voice" className="ph-no-capture">
      <Navbar backLink="Назад" title="Голос агента" />
      <div style={{ padding: '8px 16px 0' }} data-testid="voice-tabs">
        <Segmented strong tag="div">
          {TABS.map((t) => (
            <Button key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </Button>
          ))}
        </Segmented>
      </div>
      <List
        strong
        inset
        className="rd-menu"
        style={{ marginTop: 8, marginBottom: 0 }}
        data-testid="voice-list"
      >
        {rows(tab === 'female' ? FEMALE_VOICES : MALE_VOICES)}
      </List>
    </Page>
  )
}
