import { parentPort } from 'node:worker_threads'
import opus from '@evan/opus/wasm/index.js'
import type { OpusReply, OpusRequest } from './opus-pool'

/**
 * The Opus encoder of the agent's speech, in a worker thread (opus-pool.ts starts it and describes the
 * messages). A second of speech costs the encoder about 9 ms of CPU; on the main thread that would
 * stall every open dialog of the pod while it runs.
 *
 * One encoder per speech: the packets of a speech form one stream and each depends on the ones before
 * it. A frame from the agent is 200 ms, which is ten whole packets; a shorter one (the end of a
 * sentence) leaves a tail under 20 ms, and the tail waits for the next frame instead of being padded
 * with silence in the middle of the speech. Only `finish` pads it, at the end of the speech.
 *
 * This file is self-contained on purpose: in development and tests Node runs it as is, stripping the
 * types, so it imports nothing but Node, the codec and types.
 */

/** libopus request numbers (opus_defines.h). */
const OPUS_SET_BITRATE = 4002
const OPUS_SET_COMPLEXITY = 4010
/** 20 ms per packet, the length the client side expects. */
const PACKET_MS = 20
/** Bytes per sample: PCM16. */
const SAMPLE_BYTES = 2

interface Stream {
  encoder: InstanceType<typeof opus.Encoder>
  /** Bytes of PCM16 in one packet. */
  packetBytes: number
  /** Samples left over from the previous frame, fewer than one packet. */
  carry: Uint8Array
}

const streams = new Map<number, Stream>()

/** Length-prefixed packets (uint16 big-endian, then the bytes): the body of a `0x02` frame. */
function pack(packets: Uint8Array[]): ArrayBuffer | null {
  if (packets.length === 0) return null
  const body = new Uint8Array(packets.reduce((total, packet) => total + 2 + packet.length, 0))
  let at = 0
  for (const packet of packets) {
    body[at] = packet.length >> 8
    body[at + 1] = packet.length & 0xff
    body.set(packet, at + 2)
    at += 2 + packet.length
  }
  return body.buffer
}

/** Every whole packet in what the stream holds; the rest stays for the next frame. */
function encodeWhole(stream: Stream, pcm: Uint8Array): Uint8Array[] {
  const samples = new Uint8Array(stream.carry.length + pcm.length)
  samples.set(stream.carry)
  samples.set(pcm, stream.carry.length)
  const whole = samples.length - (samples.length % stream.packetBytes)
  const packets: Uint8Array[] = []
  for (let at = 0; at < whole; at += stream.packetBytes) {
    packets.push(stream.encoder.encode(samples.subarray(at, at + stream.packetBytes)))
  }
  stream.carry = samples.slice(whole)
  return packets
}

function close(id: number): void {
  streams.get(id)?.encoder.drop()
  streams.delete(id)
}

function handle(request: OpusRequest): OpusReply | null {
  switch (request.kind) {
    case 'open': {
      const encoder = new opus.Encoder({
        channels: 1,
        sample_rate: request.sampleRate as 24000,
        application: 'voip',
      })
      encoder.ctl(OPUS_SET_BITRATE, request.bitrate)
      encoder.ctl(OPUS_SET_COMPLEXITY, request.complexity)
      const packetBytes = ((request.sampleRate * PACKET_MS) / 1000) * SAMPLE_BYTES
      streams.set(request.stream, { encoder, packetBytes, carry: new Uint8Array(0) })
      return null
    }
    case 'encode': {
      const stream = streams.get(request.stream)
      if (!stream) return { job: request.job, body: null, error: 'unknown stream' }
      // PCM16 is two bytes a sample: an odd byte at the end is not a sample.
      const pcm = new Uint8Array(
        request.pcm,
        0,
        request.pcm.byteLength - (request.pcm.byteLength % SAMPLE_BYTES),
      )
      return { job: request.job, body: pack(encodeWhole(stream, pcm)) }
    }
    case 'finish': {
      const stream = streams.get(request.stream)
      if (!stream) return { job: request.job, body: null }
      let body: ArrayBuffer | null = null
      if (stream.carry.length > 0) {
        // The end of the speech: the tail is padded with silence to a whole packet.
        const last = new Uint8Array(stream.packetBytes)
        last.set(stream.carry)
        body = pack([stream.encoder.encode(last)])
      }
      close(request.stream)
      return { job: request.job, body }
    }
    case 'close':
      close(request.stream)
      return null
  }
}

parentPort?.on('message', (request: OpusRequest) => {
  let reply: OpusReply | null
  try {
    reply = handle(request)
  } catch (error) {
    // A stream that failed to open or to encode is gone; its next jobs answer "unknown stream".
    if (request.kind !== 'close') close(request.stream)
    reply = 'job' in request ? { job: request.job, body: null, error: String(error) } : null
  }
  if (!reply) return
  parentPort?.postMessage(reply, reply.body ? [reply.body] : [])
})
