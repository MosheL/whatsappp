import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'fs/promises'
import { test } from 'node:test'
import {
  WHATSAPP_AUDIO_MIME,
  baseFileName,
  convertAudioToMp3,
  fileExtension,
  isAudioUpload,
  isWhatsAppAudio,
  prepareAudioUpload
} from '../src/audio-convert.ts'

function ffmpegAvailable(): boolean {
  const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' })
  return result.status === 0
}

// Minimal 16-bit PCM mono WAV so the real-ffmpeg test needs no fixture file.
function makeWav(seconds = 0.2, rate = 8000): Buffer {
  const samples = Math.floor(rate * seconds)
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 12000), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

test('detects audio uploads by mimetype or extension', () => {
  assert.equal(isAudioUpload('audio/mpeg', 'song.mp3'), true)
  assert.equal(isAudioUpload('audio/wav', 'voice.wav'), true)
  assert.equal(isAudioUpload('application/ogg', 'voice.ogg'), true)
  assert.equal(isAudioUpload('', 'voice.flac'), true)
  assert.equal(isAudioUpload('application/octet-stream', 'clip.m4a'), true)
  assert.equal(isAudioUpload('application/octet-stream', 'Voice Memo.AMR'), true)
  assert.equal(isAudioUpload('video/mp4', 'mislabelled.m4a'), true)
  assert.equal(isAudioUpload('application/octet-stream', 'no-extension'), false)

  assert.equal(isAudioUpload('application/pdf', 'report.pdf'), false)
  assert.equal(isAudioUpload('application/octet-stream', 'report.pdf'), false)
  assert.equal(isAudioUpload('image/png', 'photo.png'), false)
  assert.equal(isAudioUpload('video/mp4', 'movie.mp4'), false)
})

test('treats only mp3 and aac/m4a as WhatsApp-ready audio', () => {
  assert.equal(isWhatsAppAudio('audio/mpeg', 'song.mp3'), true)
  assert.equal(isWhatsAppAudio('audio/mp3', 'song.mp3'), true)
  assert.equal(isWhatsAppAudio('audio/aac', 'song.aac'), true)
  assert.equal(isWhatsAppAudio('audio/mp4', 'song.m4a'), true)
  assert.equal(isWhatsAppAudio('audio/x-m4a', 'song.m4a'), true)
  assert.equal(isWhatsAppAudio('audio/mpeg', 'song'), true)
  assert.equal(isWhatsAppAudio('', 'song.mp3'), true)
  assert.equal(isWhatsAppAudio('application/octet-stream', 'song.m4a'), true)

  // Formats WhatsApp cannot play inline must be transcoded.
  assert.equal(isWhatsAppAudio('audio/wav', 'voice.wav'), false)
  assert.equal(isWhatsAppAudio('audio/x-wav', 'voice.wav'), false)
  assert.equal(isWhatsAppAudio('audio/flac', 'voice.flac'), false)
  assert.equal(isWhatsAppAudio('audio/ogg', 'voice.ogg'), false)
  assert.equal(isWhatsAppAudio('audio/ogg; codecs=opus', 'voice.ogg'), false)
  assert.equal(isWhatsAppAudio('audio/opus', 'voice.opus'), false)
  assert.equal(isWhatsAppAudio('audio/amr', 'voice.amr'), false)
  assert.equal(isWhatsAppAudio('audio/aiff', 'voice.aiff'), false)

  // A contradicting mimetype beats a lying extension.
  assert.equal(isWhatsAppAudio('audio/wav', 'not-really.mp3'), false)
  assert.equal(isWhatsAppAudio('audio/mpeg', 'really-a-wav.wav'), false)
})

test('handles extensions and base names for odd file names', () => {
  assert.equal(fileExtension('Voice Memo.AMR'), 'amr')
  assert.equal(fileExtension('no-extension'), '')
  assert.equal(fileExtension('trailing.'), '')
  assert.equal(baseFileName('song.live.wav'), 'song.live')
  assert.equal(baseFileName('.hidden'), '.hidden')
  assert.equal(baseFileName(''), 'audio')
})

test('passes through audio WhatsApp already supports', async () => {
  let ran = false
  const result = await prepareAudioUpload(Buffer.from('mp3'), 'song.mp3', 'audio/mpeg', {
    run: async () => { ran = true }
  })
  assert.equal(result, null)
  assert.equal(ran, false)
})

test('ignores non-audio uploads', async () => {
  let ran = false
  const result = await prepareAudioUpload(Buffer.from('%PDF'), 'report.pdf', 'application/pdf', {
    run: async () => { ran = true }
  })
  assert.equal(result, null)
  assert.equal(ran, false)
})

test('converts other audio to an mp3 upload', async () => {
  let invokedWith = ''
  const result = await prepareAudioUpload(Buffer.from('wav-bytes'), 'Voice Memo.ogg', 'audio/ogg', {
    run: async ({ input, output, ffmpegPath }) => {
      invokedWith = ffmpegPath
      assert.equal(await fs.readFile(input, 'utf8'), 'wav-bytes')
      await fs.writeFile(output, Buffer.from('mp3-bytes'))
    }
  })

  assert.ok(invokedWith)
  assert.equal(result?.fileName, 'Voice Memo.mp3')
  assert.equal(result?.mimeType, WHATSAPP_AUDIO_MIME)
  assert.equal(result?.buffer.toString(), 'mp3-bytes')
})

test('reports a clear error when ffmpeg is missing', async () => {
  await assert.rejects(
    () => convertAudioToMp3(Buffer.from('wav'), 'voice.wav', { ffmpegPath: 'definitely-not-ffmpeg' }),
    /ffmpeg not found \(definitely-not-ffmpeg\)/
  )
})

test('rejects an empty conversion result', async () => {
  await assert.rejects(
    () => convertAudioToMp3(Buffer.from('wav'), 'voice.wav', {
      run: async ({ output }) => { await fs.writeFile(output, '') }
    }),
    /empty file/
  )
})

test('really converts wav to a playable mp3 when ffmpeg is installed', { skip: !ffmpegAvailable() }, async () => {
  const converted = await convertAudioToMp3(makeWav(), 'tone.wav')

  assert.equal(converted.fileName, 'tone.mp3')
  assert.equal(converted.mimeType, 'audio/mpeg')
  assert.ok(converted.buffer.length > 500, `mp3 should not be empty (got ${converted.buffer.length} bytes)`)
  // MP3 files start with an ID3 tag or an MPEG frame sync (0xFF 0xEx/0xFx).
  const startsWithId3 = converted.buffer.subarray(0, 3).toString() === 'ID3'
  const startsWithFrame = converted.buffer[0] === 0xFF && (converted.buffer[1] & 0xE0) === 0xE0
  assert.ok(startsWithId3 || startsWithFrame, 'output is not an MP3 stream')
})

test('surfaces ffmpeg errors for undecodable input', { skip: !ffmpegAvailable() }, async () => {
  await assert.rejects(
    () => convertAudioToMp3(Buffer.from('this is definitely not audio'), 'broken.wav'),
    /Audio conversion failed/
  )
})
