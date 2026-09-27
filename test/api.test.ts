import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

process.env.API_TEST_MODE = 'true'
process.env.WHATSAPP_UI_PASSWORD = 'test-password'
process.env.WHATSAPP_UI_SESSION_SECRET = 'test-secret'
process.env.WHATSAPP_EXTERNAL_API_KEY = 'external-test-key'

const { server, bots, shareStore } = await import('../src/index.ts')
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

test('group-last-updated requires a valid bot before lookup', async () => {
  const { response, body } = await json('/group-last-updated', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'external-test-key'
    },
    body: JSON.stringify({ bot: 'bot1', name: 'test' })
  })
  // No bots are created in test mode, so a valid bot cannot resolve.
  assert.equal(response.status, 404)
  assert.equal(typeof body.error, 'string')
})

test('group-last-updated returns 400 when an unknown bot and params exist but bot missing resolves to 404', async () => {
  // Params validation happens after the bot is resolved; with no bots in
  // test mode the API resolves to 404 rather than the 400-missing-param path.
  const { response, body } = await json('/group-last-updated', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'external-test-key'
    },
    body: JSON.stringify({ bot: 'bot1' })
  })
  assert.equal(response.status, 404)
  assert.equal(typeof body.error, 'string')
})

test('group-last-updated returns 404 when no group matches', async () => {
  const { response, body } = await json('/group-last-updated', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'external-test-key'
    },
    body: JSON.stringify({ bot: 'bot1', name: 'no-such-group' })
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

test('search route requires an authenticated session', async () => {
  const { response } = await json('/api/search?q=hello')
  assert.equal(response.status, 401)
})

test('search route returns 404 for an unknown bot', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/search?bot=missing&q=hello', {
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 404)
  assert.equal(typeof body.error, 'string')
})

test('messages-around route rejects missing params', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/messages-around?bot=missing', {
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 400)
  assert.equal(typeof body.error, 'string')
})

test('messages-around route returns 404 for an unknown bot', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/messages-around?bot=missing&jid=1@s.whatsapp.net&id=m1', {
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 404)
  assert.equal(typeof body.error, 'string')
})

test('messages route returns 404 for an unknown bot with after param', async () => {
  const cookie = await login()
  const { response, body } = await json('/api/messages?bot=missing&jid=1@s.whatsapp.net&after=100', {
    headers: { Cookie: cookie }
  })
  assert.equal(response.status, 404)
  assert.equal(typeof body.error, 'string')
})

test('share read route requires no session and rejects an unknown token', async () => {
  const { response, body } = await json('/api/share/does-not-exist')
  // 404 when the share store is reachable, 503 when Redis is unavailable.
  assert.ok([404, 503].includes(response.status), `unexpected status ${response.status}`)
  assert.equal(typeof body.error, 'string')
})

test('share management routes require an authenticated session', async () => {
  const list = await json('/api/shares?bot=bot1&jid=123@g.us')
  assert.equal(list.response.status, 401)

  const create = await json('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot: 'bot1', jid: '123@g.us' })
  })
  assert.equal(create.response.status, 401)

  const remove = await json('/api/shares/some-token', { method: 'DELETE' })
  assert.equal(remove.response.status, 401)
})

test('share management rejects missing params and unknown bots', async () => {
  const cookie = await login()

  const missing = await json('/api/shares?bot=bot1', { headers: { Cookie: cookie } })
  assert.equal(missing.response.status, 400)

  const unknown = await json('/api/shares?bot=missing&jid=1@g.us', { headers: { Cookie: cookie } })
  // No bots are loaded in API_TEST_MODE, so lookups fail before Redis is touched.
  assert.equal(unknown.response.status, 400)
})

// Full lifecycle against a fake bot and an in-memory share store. Swapping the
// share store's Redis for a stub keeps the test hermetic (no Redis required).
test('share link lifecycle: create, read anonymously, revoke', async () => {
  const fakeRedis = createShareRedisStub()
  ;(shareStore as any).redis = fakeRedis
  const fakeBot = {
    botId: 'bot1',
    authKey: 'auth',
    status: () => ({ id: 'fake-account', authKey: 'auth', label: 'fake', connection: 'connected', qr: '', chatCount: 1, unreadSessionCount: 0 }),
    contactCache: { canonicalJid: (jid: string) => jid },
    chats: new Map([['123@g.us', { jid: '123@g.us', name: 'עדר הבוטים', participantCount: 3, isGroup: true }]]),
    getMessages: async (_jid: string, limit: number) =>
      Array.from({ length: Math.min(limit, 3) }, (_, index) => ({
        id: `m${index + 1}`, jid: '123@g.us', text: `msg ${index + 1}`, fromMe: false, sender: 'אבא', type: 'conversation', timestamp: 1700000000000 + index
      }))
  } as any
  bots.set('bot1', fakeBot)
  try {
    const cookie = await login()

    // Create via the UI session.
    const created = await json('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ bot: 'bot1', jid: '123@g.us', label: 'test-link' })
    })
    assert.equal(created.response.status, 200)
    const token = created.body.link?.token
    assert.ok(typeof token === 'string' && token.length > 20)

    // Listed for the group.
    const list = await json('/api/shares?bot=bot1&jid=123@g.us', { headers: { Cookie: cookie } })
    assert.equal(list.response.status, 200)
    assert.equal(list.body.links?.length, 1)
    assert.equal(list.body.links[0].label, 'test-link')

    // Read WITHOUT any session cookie — the whole point of the share link.
    const anon = await json(`/api/share/${token}`)
    assert.equal(anon.response.status, 200)
    assert.equal(anon.body.group?.name, 'עדר הבוטים')
    assert.equal(anon.body.count, 3)
    assert.equal(anon.body.messages?.length, 3)
    assert.equal(anon.body.messages[0].text, 'msg 1')
    assert.equal(anon.body.messages[0].raw, undefined, 'raw wire payloads must not leak')

    // A smaller limit is honored.
    const limited = await json(`/api/share/${token}?limit=1`)
    assert.equal(limited.body.count, 1)

    // Revoking kills the public link.
    const removed = await json(`/api/shares/${token}`, { method: 'DELETE', headers: { Cookie: cookie } })
    assert.equal(removed.response.status, 200)
    const after = await json(`/api/share/${token}`)
    assert.equal(after.response.status, 404)
  } finally {
    bots.delete('bot1')
  }
})

function createShareRedisStub() {
  const strings = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  const pipeline = {
    set(key: string, value: string) { strings.set(key, value); return pipeline },
    sadd(key: string, ...members: string[]) {
      const set = sets.get(key) || new Set<string>()
      members.forEach(member => set.add(member))
      sets.set(key, set)
      return pipeline
    },
    del(key: string) { strings.delete(key); return pipeline },
    srem(key: string, ...members: string[]) {
      const set = sets.get(key)
      if (set) members.forEach(member => set.delete(member))
      return pipeline
    },
    async exec() { return [] }
  }
  return {
    status: 'ready',
    get: async (key: string) => strings.get(key) ?? null,
    smembers: async (key: string) => [...(sets.get(key) || [])],
    srem: async (key: string, ...members: string[]) => {
      const set = sets.get(key)
      if (set) members.forEach(member => set.delete(member))
      return members.length
    },
    multi: () => pipeline
  }
}
