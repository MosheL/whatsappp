import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MessageStore } from '../src/message-store.ts'

function createRedis(messages: any[] = []) {
  const payloads = new Map(messages.map(message => [`payload:${message.jid}:${message.id}`, JSON.stringify(message)]))
  const indexes = new Map<string, string[]>()
  for (const message of messages) {
    const ids = indexes.get(message.jid) || []
    ids.push(message.id)
    indexes.set(message.jid, ids)
  }
  return {
    payloads,
    indexes,
    zrange: async (key: string, start: number, end: number) => {
      const ids = indexes.get(key.replace('index:', '')) || []
      const from = start < 0 ? Math.max(0, ids.length + start) : start
      const to = end < 0 ? ids.length + end : end
      return ids.slice(from, to + 1)
    },
    zrevrangebyscore: async (_key: string, before: string, _min: string, _limit: string, _offset: number, limit: number) => {
      const timestamp = Number(before.slice(1))
      return messages.filter(message => message.timestamp < timestamp).reverse().slice(0, limit).map(message => message.id)
    },
    mget: async (...keys: string[]) => keys.map(key => payloads.get(key) || null),
    get: async (key: string) => payloads.get(key) || null,
    zrem: async () => 0,
    multi: () => {
      const operations: (() => void)[] = []
      const tx = {
        set(key: string, value: string) { operations.push(() => payloads.set(key, value)); return tx },
        zadd(key: string, _score: number, id: string) {
          operations.push(() => {
            const jid = key.replace('index:', '')
            const ids = indexes.get(jid) || []
            if (!ids.includes(id)) ids.push(id)
            indexes.set(jid, ids)
          })
          return tx
        },
        del(key: string) {
          operations.push(() => {
            if (key.startsWith('index:')) indexes.delete(key.replace('index:', ''))
            else payloads.delete(key)
          })
          return tx
        },
        exec: async () => { operations.forEach(operation => operation()); return [] }
      }
      return tx
    }
  }
}

function createStore(options: { messages?: any[]; sock?: any; memory?: any[] } = {}) {
  const stored = options.messages || []
  const memory = new Map<string, any[]>()
  if (options.memory) memory.set('chat', options.memory)
  return new MessageStore({
    redis: createRedis(stored),
    label: 'test',
    messageIndexKey: jid => `index:${jid}`,
    messagePayloadKey: (jid, id) => `payload:${jid}:${id}`,
    mediaCacheKey: (jid, id) => `media:${jid}:${id}`,
    MEDIA_CACHE_TTL_SECONDS: 60,
    STORED_MESSAGE_LIMIT: 0,
    MEMORY_MESSAGE_LIMIT: 300,
    HISTORY_SYNC_WAIT_MS: 120000,
    canonicalJid: jid => jid,
    messages: memory,
    chats: new Map(),
    listChats: () => [],
    getSock: () => options.sock,
    publicMessage: message => {
      const { raw, ...safe } = message
      return safe
    },
    onMessageEvent: () => {}
  })
}

test('full-history sync uses the live socket and deduplicates requests', async () => {
  let calls = 0
  const store = createStore({
    sock: {
      sendPeerDataOperationMessage: async () => {
        calls++
        return 'request-1'
      }
    }
  })

  const [first, second] = await Promise.all([store.requestFullHistorySync(), store.requestFullHistorySync()])
  assert.equal(first, 'request-1')
  assert.equal(second, 'request-1')
  assert.equal(await store.requestFullHistorySync(), 'request-1')
  assert.equal(calls, 1)
})

test('phone rejection immediately fails a full-history wait', async () => {
  const store = createStore({ sock: { sendPeerDataOperationMessage: async () => 'request-1' } })
  await store.requestFullHistorySync()
  store.recordFullHistoryResponse(undefined, 1, 'REJECTED')
  await assert.rejects(store.waitForStoredMessages('chat', 1000), /Phone rejected history sync: REJECTED/)
})

test('getMessages loads the requested amount from Redis and sanitizes messages', async () => {
  const stored = Array.from({ length: 400 }, (_, index) => ({
    id: String(index),
    jid: 'chat',
    timestamp: index,
    raw: { secret: true },
    text: String(index)
  }))
  const store = createStore({ messages: stored, memory: stored.slice(-300) })
  const result = await store.getMessages('chat', 400)

  assert.equal(result.length, 400)
  assert.equal('raw' in result[0], false)
})

test('mergeMessageStore moves orphaned messages to the canonical chat', async () => {
  const fromJid = '972506212172:0@s.whatsapp.net'
  const toJid = '972506212172@s.whatsapp.net'
  const store = createStore({
    messages: [{ id: 'morning', jid: fromJid, key: { remoteJid: fromJid }, timestamp: 10, text: 'morning' }]
  })

  await store.mergeMessageStore(fromJid, toJid)
  const result = await store.getMessages(toJid, 10)

  assert.equal(result.length, 1)
  assert.equal(result[0].jid, toJid)
  assert.equal(result[0].key.remoteJid, toJid)
})
