import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// WhatsApp only plays a couple of audio containers inline:
//   - MP3  (audio/mpeg)
//   - AAC  (audio/aac, usually carried in an .m4a / MP4 container)
// Everything else (wav, flac, ogg/opus, amr, aiff, wma, ...) is either dropped,
// shown as "unsupported", or played silently. When a user drags such a file
// into the UI we transcode it to MP3 with ffmpeg before uploading.

export const WHATSAPP_AUDIO_MIME = 'audio/mpeg'

const MP3_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mpeg3',
  'audio/x-mpeg-3',
  'audio/x-mp3'
])

const AAC_MIMES = new Set([
  'audio/aac',
  'audio/aacp',
  'audio/x-aac',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mp4a-latm'
])

const MP3_EXTS = new Set(['mp3', 'mpga', 'mp2'])
const AAC_EXTS = new Set(['aac', 'm4a', 'm4b', 'm4p', 'm4r', 'mp4a'])

// Extensions worth trying to transcode: audio containers ffmpeg understands.
const AUDIO_EXTS = new Set([
  ...MP3_EXTS,
  ...AAC_EXTS,
  'wav', 'wave', 'ogg', 'oga', 'opus', 'flac', 'amr', 'awb',
  'aiff', 'aif', 'aifc', 'wma', 'mka', 'caf', 'au', 'snd', 'ra', 'ape', 'wv', 'voc'
])

const SUPPORTED_MIMES = new Set([...MP3_MIMES, ...AAC_MIMES])

export function baseMime(mimeType: string | undefined): string {
  return String(mimeType || '').split(';')[0].trim().toLowerCase()
}

export function fileExtension(fileName: string | undefined): string {
  const clean = String(fileName || '').trim().toLowerCase()
  const dot = clean.lastIndexOf('.')
  if (dot < 0 || dot === clean.length - 1) return ''
  return clean.slice(dot + 1).replace(/[^a-z0-9]/g, '')
}

/** True when the upload should be treated as audio (by mimetype or extension). */
export function isAudioUpload(mimeType: string | undefined, fileName = ''): boolean {
  const mime = baseMime(mimeType)
  if (mime.startsWith('audio/') || mime === 'application/ogg' || mime === 'application/x-ogg') return true
  // Browsers mislabel some audio containers (notably .m4a/.amr on Windows as
  // video/mp4 or application/octet-stream); the extension is the better hint.
  return AUDIO_EXTS.has(fileExtension(fileName))
}

/** True when WhatsApp can play the file as-is (MP3 or AAC in an MP4 container). */
export function isWhatsAppAudio(mimeType: string | undefined, fileName = ''): boolean {
  const mime = baseMime(mimeType)
  const ext = fileExtension(fileName)
  const supportedByMime = SUPPORTED_MIMES.has(mime)
  const supportedByExt = MP3_EXTS.has(ext) || AAC_EXTS.has(ext)
  // Convert when either signal disagrees: a renamed .mp3 that is really WAV,
  // and a .wav announced as audio/mpeg, both must be transcoded.
  if (mime && mime !== 'application/octet-stream') return supportedByMime && (supportedByExt || !ext)
  return supportedByExt
}

/** Base name without its final extension, e.g. `song.live.wav` -> `song.live`. */
export function baseFileName(fileName: string | undefined): string {
  const clean = path.basename(String(fileName || '').trim() || 'audio')
  const dot = clean.lastIndexOf('.')
  return dot > 0 ? clean.slice(0, dot) : clean
}

export type ConvertAudioOptions = {
  /** Binary to execute. Defaults to `FFMPEG_PATH` or `ffmpeg` from PATH. */
  ffmpegPath?: string
  /** Hard limit for one conversion. Defaults to `FFMPEG_TIMEOUT_MS` or 120s. */
  timeoutMs?: number
  /** Test hook: replaces the actual ffmpeg invocation; must write `output`. */
  run?: (args: { ffmpegPath: string, input: string, output: string, timeoutMs: number }) => Promise<void>
}

export type ConvertedAudio = {
  buffer: Buffer
  fileName: string
  mimeType: string
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

function ffmpegTimeoutMs(): number {
  const value = Number(process.env.FFMPEG_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : 120_000
}

function runFfmpeg({ ffmpegPath: bin, input, output, timeoutMs }: { ffmpegPath: string, input: string, output: string, timeoutMs: number }) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', output],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        if ((error as any).code === 'ENOENT') {
          reject(new Error(`ffmpeg not found (${bin}). Install ffmpeg or set FFMPEG_PATH.`))
          return
        }
        const detail = String(stderr || error.message || '').trim().split('\n').slice(-3).join(' ')
        reject(new Error(`Audio conversion failed: ${detail || error.message}`))
      }
    )
  })
}

/**
 * Transcode any audio buffer ffmpeg understands into an MP3 WhatsApp can play.
 * Uses a temp directory (not stdin/stdout) so MP4/M4A inputs with a trailing
 * `moov` atom still work reliably.
 */
export async function convertAudioToMp3(buffer: Buffer, fileName: string, options: ConvertAudioOptions = {}): Promise<ConvertedAudio> {
  const bin = options.ffmpegPath || ffmpegPath()
  const timeoutMs = options.timeoutMs || ffmpegTimeoutMs()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-audio-'))
  const ext = fileExtension(fileName) || 'bin'
  const input = path.join(dir, `input.${ext}`)
  const output = path.join(dir, 'output.mp3')
  try {
    await fs.writeFile(input, buffer)
    await (options.run || runFfmpeg)({ ffmpegPath: bin, input, output, timeoutMs })
    const mp3 = await fs.readFile(output)
    if (!mp3.length) throw new Error('Audio conversion produced an empty file')
    return { buffer: mp3, fileName: `${baseFileName(fileName)}.mp3`, mimeType: WHATSAPP_AUDIO_MIME }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Convert an upload only when it is audio WhatsApp cannot play, otherwise
 * return null so the caller sends the original bytes untouched.
 */
export async function prepareAudioUpload(
  buffer: Buffer,
  fileName: string,
  mimeType: string | undefined,
  options: ConvertAudioOptions = {}
): Promise<ConvertedAudio | null> {
  if (!isAudioUpload(mimeType, fileName) || isWhatsAppAudio(mimeType, fileName)) return null
  return convertAudioToMp3(buffer, fileName, options)
}
