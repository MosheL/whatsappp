import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('../web/src/App.vue', import.meta.url), 'utf8')
const ref = value => ({ value })

// Execute the actual component functions with browser/network dependencies mocked.
function harness(names, globals) {
  const context = createContext(globals)
  for (const name of names) {
    const code = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))?.[0]
    assert.ok(code, `Missing component function ${name}`)
    runInContext(code, context)
  }
  return context
}

test('every websocket init reconciles unread state, including a quick reconnect', async () => {
  const sockets = []
  let refreshes = 0
  const context = harness(['connectWs'], {
    ws: null, reconnectTimer: null, wsState: ref(''), authenticated: ref(true),
    location: { protocol: 'https:', host: 'example.test' },
    clearTimeout() {}, setTimeout() {},
    WebSocket: class { constructor() { sockets.push(this) } close() {} },
    bots: ref([]), selectedBot: ref('bot'), localStorage: { setItem() {} },
    refreshQr: async () => {}, refreshAfterReconnect: async () => { refreshes++ }
  })
  const init = { data: JSON.stringify({ type: 'init', bots: [{ id: 'bot' }] }) }
  context.connectWs()
  sockets[0].onopen()
  await sockets[0].onmessage(init)
  sockets[0].onclose()
  context.connectWs()
  sockets[1].onopen()
  await sockets[1].onmessage(init)
  assert.equal(refreshes, 2)
  const state = context.wsState.value
  sockets[0].onclose()
  assert.equal(context.wsState.value, state, 'an old socket cannot disconnect the new one')
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
    refreshBots: async () => {}, loadChats: async () => { calls.push('chats') },
    loadContacts: async () => {}, autoMarkChatRead() {}, unreadTotal: ref(4),
    updateAppBadge: count => calls.push(count), error: ref('')
  })
  await context.refreshAfterReconnect()
  assert.deepEqual(calls, ['chats', 4])
})
