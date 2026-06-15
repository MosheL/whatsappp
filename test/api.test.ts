import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

process.env.API_TEST_MODE = 'true'
process.env.WHATSAPP_UI_PASSWORD = 'test-password'
process.env.WHATSAPP_UI_SESSION_SECRET = 'test-secret'
process.env.WHATSAPP_EXTERNAL_API_KEY = 'external-test-key'

const { server } = await import('../src/index.ts')
let baseUrl = ''

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
})

async function json(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, options)
  return { response, body: await response.json() as Record<string, any> }
}

async function login() {
  const { response, body } = await json('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' })
  })
  assert.equal(response.status, 200)
  assert.equal(body.token, undefined)
  const cookie = response.headers.get('set-cookie')?.split(';')[0] || ''
  assert.match(cookie, /^wa_ui_session=/)
  return cookie
}

test('rejects API requests without authentication', async () => {
  const { response, body } = await json('/api/session')
  assert.equal(response.status, 401)
  assert.equal(typeof body.error, 'string')
})

test('rejects an incorrect password', async () => {
  const { response, body } = await json('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' })
  })
  assert.equal(response.status, 401)
  assert.equal(typeof body.error, 'string')
})

test('logs in and returns an authenticated session', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/session', {
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 200)
  assert.deepEqual(body.bots, [])
})

test('returns 404 for an unknown bot', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/chats?bot=missing', {
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 404)
  assert.equal(typeof body.error, 'string')
})

test('returns 400 for invalid JSON', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/sync-messages', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json'
    },
    body: '{'
  })
  assert.equal(response.status, 400)
  assert.equal(typeof body.error, 'string')
})

test('rejects the external send route without its dedicated API key', async () => {
  const { response, body } = await json('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot: 'missing', jid: '1@s.whatsapp.net', text: 'hello' })
  })
  assert.equal(response.status, 401)
  assert.equal(typeof body.error, 'string')
})

test('accepts the dedicated external API key before resolving the bot', async () => {
  const { response, body } = await json('/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'external-test-key'
    },
    body: JSON.stringify({ bot: 'missing', jid: '1@s.whatsapp.net', text: 'hello' })
  })
  assert.equal(response.status, 404)
  assert.equal(typeof body.error, 'string')
})

test('clears the session cookie on logout', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/logout', {
    method: 'POST',
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/)
})
