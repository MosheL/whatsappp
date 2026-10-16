import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transcribeBuffer, transcribeEndpoint, transcribeModel } from '../src/bot.ts'

const KEYS = ['TRANSCRIBE_URL', 'TRANSCRIBE_HOST', 'TRANSCRIBE_PORT', 'TRANSCRIBE_MODEL', 'REDIS_HOST'] as const

function withEnv(vars: Partial<Record<(typeof KEYS)[number], string | undefined>>, fn: () => void) {
  const saved = new Map<string, string | undefined>()
  for (const key of KEYS) saved.set(key, process.env[key])
  for (const key of KEYS) {
    const value = vars[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('transcribeEndpoint defaults to REDIS_HOST:8000/transcribe', () => {
  withEnv({ TRANSCRIBE_URL: undefined, TRANSCRIBE_HOST: undefined, TRANSCRIBE_PORT: undefined, REDIS_HOST: '10.0.0.5' }, () => {
    assert.equal(transcribeEndpoint(), 'http://10.0.0.5:8000/transcribe')
  })
})

test('transcribeEndpoint honours TRANSCRIBE_HOST and TRANSCRIBE_PORT', () => {
  withEnv({ TRANSCRIBE_URL: undefined, TRANSCRIBE_HOST: '192.168.50.10', TRANSCRIBE_PORT: '9000', REDIS_HOST: '10.0.0.5' }, () => {
    assert.equal(transcribeEndpoint(), 'http://192.168.50.10:9000/transcribe')
  })
})

test('transcribeEndpoint lets TRANSCRIBE_URL win over host/port', () => {
  withEnv({ TRANSCRIBE_URL: 'https://asr.internal/v1/transcribe', TRANSCRIBE_HOST: '192.168.50.10', TRANSCRIBE_PORT: '9000' }, () => {
    assert.equal(transcribeEndpoint(), 'https://asr.internal/v1/transcribe')
  })
})

test('transcribeEndpoint explicit argument wins over every env var', () => {
  withEnv({ TRANSCRIBE_URL: 'http://env-url/transcribe', REDIS_HOST: '10.0.0.5' }, () => {
    assert.equal(transcribeEndpoint('http://call-param/transcribe'), 'http://call-param/transcribe')
  })
})

test('transcribeModel falls back to the ivrit model and honours overrides', () => {
  withEnv({ TRANSCRIBE_MODEL: undefined }, () => {
    assert.equal(transcribeModel(), 'ivrit-ai/whisper-large-v3-turbo-ct2')
    assert.equal(transcribeModel('custom/model'), 'custom/model')
  })
})

test('transcribeBuffer posts a base64 blob to the overridden URL and model', async () => {
  const calls: { url: any; init: any }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ text: 'hello world' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const out = await transcribeBuffer(Buffer.from('abc'), { url: 'http://asr:9000/transcribe', model: 'm1' })
    assert.equal(out, 'hello world')
    assert.equal(calls[0].url, 'http://asr:9000/transcribe')
    assert.deepEqual(JSON.parse(calls[0].init.body), { type: 'blob', data: Buffer.from('abc').toString('base64'), model: 'm1' })
  } finally {
    globalThis.fetch = original
  }
})

test('transcribeBuffer returns an empty string on a non-ok response', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  try {
    assert.equal(await transcribeBuffer(Buffer.from('abc'), { url: 'http://asr:9000/transcribe' }), '')
  } finally {
    globalThis.fetch = original
  }
})
