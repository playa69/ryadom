import { Button, Icon, List, ListItem, Sheet } from 'framework7-react'
import { useEffect, useRef, useState } from 'react'
import type { AudioDeviceKind, AudioDeviceOption } from '../../../lib/voice/devices'
import { AUDIO_DEVICE_TEXT, type AudioRoutingView } from '../../../lib/voice/routing'

/**
 * Which microphone hears the person and where the companion's voice goes: a chip under the voice
 * controls and the sheet it opens. Only when there is something to choose: a phone lists one microphone
 * until a headset is connected, and a speaker can be chosen only on a computer (Chromium), so most
 * phones never show it.
 *
 * The chip names the microphone in use, because that is what goes wrong unseen. `attention` lights it
 * when the person seems not to be heard. The sheet stays open after a choice, so the meter can show that
 * the new microphone hears them.
 */
export default function DialogDevices({
  view,
  level,
  attention,
  onOpen,
  onChoose,
}: {
  view: AudioRoutingView
  /** How loud the open microphone is, 0..1; 0 while it is closed. */
  level: () => number
  attention: boolean
  onOpen(): void
  onChoose(kind: AudioDeviceKind, option: AudioDeviceOption): void
}) {
  const [opened, setOpened] = useState(false)
  const { inputs, outputs, input, output } = view

  return (
    <>
      <button
        type="button"
        className={`rd-voice-device${attention ? ' rd-voice-device--attention' : ''}`}
        aria-label={
          input ? `${AUDIO_DEVICE_TEXT.menu}. Слушаю через «${input.label}»` : AUDIO_DEVICE_TEXT.menu
        }
        onClick={() => {
          setOpened(true)
          onOpen()
        }}
        data-testid="voice-devices"
      >
        <Icon f7="mic" size={16} />
        <span className="rd-voice-device-name">{input?.label ?? AUDIO_DEVICE_TEXT.menu}</span>
        <Icon f7="chevron_down" size={14} />
      </button>

      <Sheet
        opened={opened}
        onSheetClosed={() => setOpened(false)}
        swipeToClose
        closeOnEscape
        backdrop
        style={{ height: 'auto' }}
        data-testid="voice-devices-menu"
      >
        <div className="rd-sheet-body rd-devices">
          <h2 className="rd-sheet-title">{AUDIO_DEVICE_TEXT.menu}</h2>

          <div className="rd-devices-head">
            <span>{AUDIO_DEVICE_TEXT.input}</span>
            {opened && <MicLevel level={level} />}
          </div>
          {/* The items are a component of ours, which List does not recognize: the ul is given by hand. */}
          <List inset strong className="rd-devices-list">
            <ul>
              {inputs.map((option) => (
                <DeviceItem
                  key={option.id}
                  name="rd-input"
                  option={option}
                  checked={option.id === input?.id}
                  onChoose={() => onChoose('input', option)}
                />
              ))}
            </ul>
          </List>

          {outputs.length > 1 && (
            <>
              <div className="rd-devices-head">
                <span>{AUDIO_DEVICE_TEXT.output}</span>
              </div>
              <List inset strong className="rd-devices-list">
                <ul>
                  {outputs.map((option) => (
                    <DeviceItem
                      key={option.id}
                      name="rd-output"
                      option={option}
                      checked={option.id === output?.id}
                      onChoose={() => onChoose('output', option)}
                    />
                  ))}
                </ul>
              </List>
            </>
          )}

          <p className="rd-caption">Выбор запомнится на этом устройстве</p>
          <Button large onClick={() => setOpened(false)}>
            Готово
          </Button>
        </div>
      </Sheet>
    </>
  )
}

function DeviceItem({
  name,
  option,
  checked,
  onChoose,
}: {
  name: string
  option: AudioDeviceOption
  checked: boolean
  onChoose(): void
}) {
  return (
    <ListItem
      radio
      radioIcon="end"
      name={name}
      value={option.id}
      checked={checked}
      onChange={onChoose}
      title={option.system ? AUDIO_DEVICE_TEXT.system : option.label}
      footer={option.system ? option.label : undefined}
      data-testid="voice-device"
    />
  )
}

/** A bar that follows the microphone: if it moves when the person speaks, this microphone hears them. */
function MicLevel({ level }: { level: () => number }) {
  const bar = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let frame = 0
    let shown = 0
    const draw = () => {
      // Rises at once and falls slowly, so a word stays visible for a moment.
      shown = Math.max(level(), shown * 0.9)
      if (bar.current) bar.current.style.transform = `scaleX(${shown})`
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [level])

  return (
    <span className="rd-devices-level" role="img" aria-label="Громкость микрофона">
      <span ref={bar} />
    </span>
  )
}
