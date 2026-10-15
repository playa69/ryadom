import type { EchoCancellation, VoiceCapture } from './capture'
import {
  listAudioDevices,
  readAudioDevices,
  resolveAudioDevice,
  SYSTEM_DEVICE_ID,
  watchAudioDevices,
  writeAudioDevice,
  type AudioDeviceKind,
  type AudioDeviceList,
  type AudioDeviceOption,
} from './devices'
import type { VoicePlayer } from './player'

/**
 * The conversation's microphone and speaker, for the web and the mobile client alike: what the menu
 * "Микрофон и звук" lists and shows as chosen, what a choice does mid-conversation, and what happens
 * when a device is plugged out or back in. The screens only draw it and say the notices.
 *
 * - Nothing chosen: the browser picks, as before (its prompt or its own settings). The menu shows which
 *   device that is, so a person talking into a headset while the page listens to the laptop sees it.
 * - A choice is kept in this browser (devices.ts) and applies at once, without restarting anything.
 * - The chosen microphone goes away: the conversation moves to the system's and says so; if none is
 *   left, listening pauses. It comes back: the conversation moves back to it.
 * - "As in the system" follows the system: Chrome keeps the device a track was opened on, so a change
 *   of the system's default reopens it.
 * - A speaker other than the system's: Chrome's echo canceller only hears what goes to the system's,
 *   so the microphone asks it to hear everything the computer plays (`EchoCancellation`).
 */

/** What the menu needs: the devices, and which are in use. */
export interface AudioRoutingView {
  inputs: AudioDeviceOption[]
  /** Empty where the page cannot choose a speaker (see `canChooseOutput`). */
  outputs: AudioDeviceOption[]
  /** The microphone in use, or the one that will be opened. Null before the browser shows any. */
  input: AudioDeviceOption | null
  output: AudioDeviceOption | null
  /** More than one microphone or more than one speaker: only then is there a menu to show. */
  choosable: boolean
}

export interface AudioRoutingHost {
  capture(): VoiceCapture | null
  player(): VoicePlayer | null
  /** The list, or what is in use, changed: the screen redraws. */
  changed(): void
  /** A device went away or came back mid-conversation, or a choice did not work: one line for the person. */
  notice(text: string): void
  /** The microphone went away and no other opened: the screen pauses listening, as after a tap. */
  inputGone(): void
  /** For the analytics: a device in use went away, and whether another took over. */
  lost?(kind: AudioDeviceKind, recovered: boolean): void
}

/** The words of the menu and of the notices, shared by both clients. */
export const AUDIO_DEVICE_TEXT = {
  menu: 'Микрофон и звук',
  input: 'Микрофон',
  output: 'Звук',
  system: 'Как в системе',
  inputLost: (lost: string, now: string) => `«${lost}» отключился. Слушаю через «${now}»`,
  inputGone: 'Микрофон отключился. Подключи его и нажми на шар',
  inputBack: (label: string) => `Снова слушаю через «${label}»`,
  inputFailed: (label: string) =>
    `Не получилось включить «${label}»: возможно, он занят другой программой. Слушаю через прежний`,
  outputLost: (label: string) => `«${label}» отключился. Звук идёт как в системе`,
  outputBack: (label: string) => `Звук снова идёт в «${label}»`,
  outputFailed: (label: string) => `Не получилось вывести звук в «${label}». Звук идёт как в системе`,
  /** Hands-free: the microphone has been open a while and has not heard a single turn. */
  notHeard: 'Не слышу тебя? Проверь микрофон',
} as const

const EMPTY: AudioDeviceList = { inputs: [], outputs: [], browserPick: { input: null, output: null } }

/** A Bluetooth headset coming on fires a burst of `devicechange`: the list is read once it settles. */
const SETTLE_MS = 300

export class AudioRouting {
  private list: AudioDeviceList = EMPTY
  /** Device work runs one at a time: two switches at once would open two microphones. */
  private queue: Promise<void> = Promise.resolve()
  private settle: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly storageKey: string,
    private readonly host: AudioRoutingHost,
  ) {}

  view(): AudioRoutingView {
    const { inputs, outputs, browserPick } = this.list
    const choice = readAudioDevices(this.storageKey)
    const inUse = this.host.capture()?.device().id
    const input =
      (inUse ? inputs.find((option) => option.id === inUse) : undefined) ??
      resolveAudioDevice(choice.input, inputs) ??
      inputs.find((option) => option.id === browserPick.input) ??
      null
    const sink = this.host.player()?.output() ?? ''
    const output = sink
      ? (outputs.find((option) => option.id === sink) ?? null)
      : (outputs.find((option) => option.system) ??
        outputs.find((option) => option.id === browserPick.output) ??
        null)
    return { inputs, outputs, input, output, choosable: inputs.length > 1 || outputs.length > 1 }
  }

  /** Follows devices being plugged in and out. Returns the stop, which also ends this object's work. */
  watch(): () => void {
    const stop = watchAudioDevices(() => {
      clearTimeout(this.settle)
      this.settle = setTimeout(() => void this.serial(() => this.devicesChanged()), SETTLE_MS)
    })
    return () => {
      this.disposed = true
      clearTimeout(this.settle)
      stop()
    }
  }

  /** Reads the devices again: when the microphone opens (names appear only after it is allowed) and when the menu opens. */
  refresh(): Promise<void> {
    return this.serial(() => this.load())
  }

  /** What `startCapture` is given: the chosen microphone if it is here (null: the browser picks), and the echo reference. */
  async captureOptions(): Promise<{ deviceId: string | null; echoCancellation: EchoCancellation }> {
    await this.refresh()
    const choice = readAudioDevices(this.storageKey)
    return {
      deviceId: this.target(choice.input, this.list.inputs),
      echoCancellation: this.echoFor(this.target(choice.output, this.list.outputs)),
    }
  }

  /** Sends the agent's voice to the chosen speaker. Call once the player exists. */
  applyOutput(): Promise<void> {
    return this.serial(async () => {
      const choice = readAudioDevices(this.storageKey).output
      if (!choice) return
      await this.load()
      await this.host.player()?.setOutput(this.speakerId(this.target(choice, this.list.outputs)))
      this.host.changed()
    })
  }

  /** The person chose a device in the menu: it is remembered and used from now on. */
  choose(kind: AudioDeviceKind, option: AudioDeviceOption): Promise<void> {
    return this.serial(async () => {
      writeAudioDevice(this.storageKey, kind, option)
      if (kind === 'input') {
        const capture = this.host.capture()
        if (capture && capture.device().id !== option.id) {
          try {
            await capture.switchDevice(option.id)
          } catch {
            this.host.notice(AUDIO_DEVICE_TEXT.inputFailed(option.label))
          }
        }
      } else {
        const routed = await this.host.player()?.setOutput(this.speakerId(option.id))
        if (routed === false) this.host.notice(AUDIO_DEVICE_TEXT.outputFailed(option.label))
        await this.matchEcho()
      }
      this.host.changed()
    })
  }

  /** `startCapture`'s `onDeviceLost`: the microphone in use went away. */
  readonly deviceLost = (): void => {
    void this.serial(async () => {
      const capture = this.host.capture()
      if (!capture) return
      const lost = capture.device().label
      await this.load()
      try {
        // The system's, rather than whatever the browser lists first: that is where a person looks.
        await capture.switchDevice(this.list.inputs.find((option) => option.system)?.id ?? null)
        this.host.notice(AUDIO_DEVICE_TEXT.inputLost(lost, this.nameOf(capture.device())))
        this.host.lost?.('input', true)
      } catch {
        this.host.notice(AUDIO_DEVICE_TEXT.inputGone)
        this.host.lost?.('input', false)
        this.host.inputGone()
      }
      this.host.changed()
    })
  }

  private async load(): Promise<void> {
    const list = await listAudioDevices()
    if (this.disposed) return
    this.list = list
    this.host.changed()
  }

  private async devicesChanged(): Promise<void> {
    const systemBefore = this.list.inputs.find((option) => option.system)?.label
    await this.load()
    if (this.disposed) return
    const choice = readAudioDevices(this.storageKey)

    const capture = this.host.capture()
    if (capture) {
      const inUse = capture.device().id
      const wanted = resolveAudioDevice(choice.input, this.list.inputs)
      const system = this.list.inputs.find((option) => option.system)
      try {
        if (wanted && inUse && wanted.id !== inUse) {
          // The chosen one is back: a headset switched on again, a cable plugged back in.
          await capture.switchDevice(wanted.id)
          this.host.notice(AUDIO_DEVICE_TEXT.inputBack(wanted.label))
        } else if (inUse === SYSTEM_DEVICE_ID && system && systemBefore && system.label !== systemBefore) {
          // "As in the system", and the system's default changed: Chrome stays on the old one until reopened.
          await capture.switchDevice(SYSTEM_DEVICE_ID)
        }
      } catch {
        // The one in use stays; a lost one is handled by `deviceLost`.
      }
    }

    const player = this.host.player()
    if (player && choice.output && this.list.outputs.length > 0) {
      const wanted = resolveAudioDevice(choice.output, this.list.outputs)
      const target = this.speakerId(wanted?.id ?? null)
      if (target !== (player.output() || null)) {
        const routed = await player.setOutput(target)
        if (!wanted) {
          this.host.notice(AUDIO_DEVICE_TEXT.outputLost(choice.output.label))
          this.host.lost?.('output', true)
        } else if (routed && target) {
          this.host.notice(AUDIO_DEVICE_TEXT.outputBack(wanted.label))
        }
        await this.matchEcho()
      }
    }
    this.host.changed()
  }

  /**
   * The id to use for a remembered device. Before the microphone is allowed the browser hides every id,
   * so the remembered one is tried as it is: a stale id falls back to the browser's pick when opened.
   */
  private target(
    choice: { id: string; label: string } | null,
    options: readonly AudioDeviceOption[],
  ): string | null {
    if (!choice) return null
    if (options.length === 0) return choice.id
    return resolveAudioDevice(choice, options)?.id ?? null
  }

  /** A microphone's name as the menu shows it: Chrome names the track of "as in the system" "Default - …". */
  private nameOf(device: { id: string; label: string }): string {
    return this.list.inputs.find((option) => option.id === device.id)?.label || device.label
  }

  /** The player's sink for a speaker id: the system's is the empty one, which follows the system. */
  private speakerId(id: string | null): string | null {
    return id === SYSTEM_DEVICE_ID ? null : id
  }

  private echoFor(speaker: string | null): EchoCancellation {
    return this.speakerId(speaker) ? 'all' : true
  }

  private async matchEcho(): Promise<void> {
    const sink = this.host.player()?.output() || null
    await this.host
      .capture()
      ?.setEchoCancellation(this.echoFor(sink))
      .catch(() => undefined)
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    this.queue = run.catch(() => undefined)
    return run
  }
}
