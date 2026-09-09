import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('../web/src/App.vue', import.meta.url), 'utf8')
const socketSource = readFileSync(new URL('../web/src/socket.js', import.meta.url), 'utf8')
const ref = value => ({ value })

// Execute the actual component functions with browser/network dependencies mocked.
function harnessFrom(src, names, globals) {
  const context = createContext(globals)
  for (const name of names) {
    const code = src.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([^]*?^}`, 'm'))?.[0]
    assert.ok(code, `Missing component function ${name}`)
    runInContext(code.replace(/^export /, ''), context)
  }
  return context
}

function harness(names, globals) {
  if (globals.chats && !globals.chatsById) {
    globals.chatsById = { get value() { return new Map(globals.chats.value.map(chat => [chat.jid, chat])) } }
  }
  return harnessFrom(source, names, globals)
}

test('every websocket init reconciles unread state, including a quick reconnect', async () => {
  const sockets = []
  const events = []
  const socketGlobals = {
    ws: null, eventHandler: null, reconnectTimer: null, heartbeatTimer: null,
    awaitingPong: false, intentionalClose: false, wsState: ref(''),
    location: { protocol: 'https:', host: 'example.test' },
    clearTimeout() {}, clearInterval() {}, setTimeout() {}, setInterval() {},
    WebSocket: class { constructor() { sockets.push(this); this.readyState = 1 } close() {} send() {} }
  }
  const context = harnessFrom(socketSource, ['connectSocket', 'disconnectSocket', 'startHeartbeat'], socketGlobals)
  const handler = data => events.push(data)

  context.connectSocket(handler)
  sockets[0].onopen()
  await sockets[0].onmessage({ data: JSON.stringify({ type: 'pong' }) })
  await sockets[0].onmessage({ data: JSON.stringify({ type: 'init', bots: [{ id: 'bot' }] }) })
  sockets[0].onclose()
  context.connectSocket(handler)
  sockets[1].onopen()
  await sockets[1].onmessage({ data: JSON.stringify({ type: 'init', bots: [{ id: 'bot' }] }) })

  // Pongs are consumed by the service; all other events reach the handler.
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { type: 'init', bots: [{ id: 'bot' }] },
    { type: 'init', bots: [{ id: 'bot' }] }
  ])
  const state = context.wsState.value
  sockets[0].onclose()
  assert.equal(context.wsState.value, state, 'an old socket cannot disconnect the new one')
  context.disconnectSocket()
  assert.equal(context.wsState.value, 'מנותק', 'an explicit disconnect is final')
})

test('handleSocketEvent refreshes the session on init', async () => {
  let refreshes = 0
  const context = harness(['handleSocketEvent'], {
    authenticated: ref(true), bots: ref([]), selectedBot: ref('bot'),
    localStorage: { setItem() {} }, refreshQr: async () => {},
    refreshAfterReconnect: async () => { refreshes++ }
  })
  await context.handleSocketEvent({ type: 'init', bots: [{ id: 'bot' }] })
  assert.equal(refreshes, 1)
  await context.handleSocketEvent({ type: 'pong' })
  assert.equal(refreshes, 1, 'only init triggers the resync')
})

test('status pushes preserve API client IDs and selection when the account ID changes', async () => {
  const stored = []
  const requests = []
  const context = harness(['handleSocketEvent', 'setBots', 'loadChats'], {
    authenticated: ref(true),
    bots: ref([{ id: 'bot1', accountId: 'old-account' }, { id: 'bot2' }]),
    selectedBot: ref('bot2'), localStorage: { setItem: (key, value) => stored.push(value) },
    refreshQr: async () => {}, lastVisibilityResync: 0,
    chatLoadRequest: 0, error: ref(''), loadingChats: ref(false),
    chats: ref([]), selectedChat: ref('chat'), filteredChats: ref([]),
    api: async url => { requests.push(url); return { chats: [] } }
  })
  for (const id of ['972500000002:1@s.whatsapp.net', '']) {
    await context.handleSocketEvent({
      type: 'connection', bot: 'bot2', status: { id, unreadSessionCount: 3 }
    })
    assert.equal(context.selectedBot.value, 'bot2')
    assert.equal(context.bots.value[1].id, 'bot2')
    assert.equal(context.bots.value[1].accountId, id)
    assert.equal(context.bots.value[1].unreadSessionCount, 3)
    assert.equal(await context.loadChats(), true)
  }
  assert.deepEqual(requests, ['/api/chats?bot=bot2', '/api/chats?bot=bot2'])
  assert.deepEqual(stored, ['bot2', 'bot2'])
})

test('background chat refresh keeps content visible and preserves it on network failure', async () => {
  let rejectRequest
  const chats = [{ jid: 'chat', unread: 3 }]
  const messages = [{ id: 'message' }]
  const context = harness(['loadChats'], {
    selectedBot: ref('bot'), authenticated: ref(true), chatLoadRequest: 0,
    error: ref(''), loadingChats: ref(false), chats: ref(chats),
    messages: ref(messages), selectedChat: ref('chat'), filteredChats: ref(chats),
    api: () => new Promise((resolve, reject) => { rejectRequest = reject })
  })
  const pending = context.loadChats()
  assert.equal(context.loadingChats.value, false)
  assert.equal(context.chats.value, chats)
  rejectRequest(new Error('offline'))
  await pending
  assert.equal(context.chats.value, chats)
  assert.equal(context.messages.value, messages)
  assert.equal(context.selectedChat.value, 'chat')
  assert.equal(context.error.value, 'offline')
})

test('badge sets unread count and clears through setAppBadge when clear is unavailable', () => {
  const counts = []
  const context = harness(['updateAppBadge'], {
    document: {}, navigator: { setAppBadge: count => { counts.push(count); return Promise.resolve() } },
    updateFaviconBadge() {}, console
  })
  context.updateAppBadge(7)
  assert.equal(context.document.title, '(7) WhatsApp')
  context.updateAppBadge(0)
  assert.deepEqual(counts, [7, 0])
})

test('resuming the app reapplies an unchanged badge after refreshing unread state', async () => {
  const calls = []
  const context = harness(['refreshAfterReconnect'], {
    refreshBots: async () => {}, loadChats: async () => { calls.push('chats'); return true },
    loadContacts: async () => {}, autoMarkChatRead() {}, unreadTotal: ref(4),
    updateAppBadge: count => calls.push(count), error: ref(''), setTimeout() {}
  })
  await context.refreshAfterReconnect()
  assert.deepEqual(calls, ['chats', 4])
})

test('a failed resume resync schedules one chat-load retry', async () => {
  const calls = []
  let retries = 0
  const context = harness(['refreshAfterReconnect'], {
    refreshBots: async () => { throw new Error('warming up') },
    loadChats: async () => { calls.push('chats'); return false },
    loadContacts: async () => {}, autoMarkChatRead() {}, unreadTotal: ref(4),
    updateAppBadge: count => calls.push(count), error: ref(''),
    authenticated: ref(true), setTimeout: fn => { retries++ },
    lastVisibilityResync: 0
  })
  await context.refreshAfterReconnect()
  assert.deepEqual(calls, [], 'no chat load is attempted when the session refresh throws')
  assert.equal(context.error.value, 'warming up')
  assert.equal(retries, 1, 'exactly one retry is scheduled')
})
