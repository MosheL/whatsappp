import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ShareStore } from '../src/share-store.ts'

// Minimal in-memory stand-in for the ioredis client used by ShareStore.
function createRedis() {
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
    strings,
    sets,
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

test('creates a token that reads back its group', async () => {
  const store = new ShareStore(createRedis(), 'test')
  const link = await store.create('bot1', '123@g.us', 'weekly')
  assert.equal(link.bot, 'bot1')
  assert.equal(link.jid, '123@g.us')
  assert.equal(link.label, 'weekly')
  assert.ok(link.token.length >= 20)

  const fetched = await store.get(link.token)
  assert.equal(fetched?.jid, '123@g.us')
  assert.equal(fetched?.label, 'weekly')
})

test('generates unique tokens per link', async () => {
  const store = new ShareStore(createRedis(), 'test')
  const a = await store.create('bot1', '123@g.us')
  const b = await store.create('bot1', '123@g.us')
  assert.notEqual(a.token, b.token)
  assert.equal((await store.list('bot1', '123@g.us')).length, 2)
})

test('lists only the links for the requested group', async () => {
  const store = new ShareStore(createRedis(), 'test')
  await store.create('bot1', '123@g.us', 'a')
  await store.create('bot1', '456@g.us', 'b')
  const list = await store.list('bot1', '123@g.us')
  assert.equal(list.length, 1)
  assert.equal(list[0].label, 'a')
})

test('unknown tokens resolve to undefined', async () => {
  const store = new ShareStore(createRedis(), 'test')
  assert.equal(await store.get('nope'), undefined)
  assert.equal(await store.get(''), undefined)
})

test('revoking a token removes it from reads and the group list', async () => {
  const store = new ShareStore(createRedis(), 'test')
  const link = await store.create('bot1', '123@g.us')
  assert.equal(await store.delete(link.token), true)
  assert.equal(await store.get(link.token), undefined)
  assert.equal((await store.list('bot1', '123@g.us')).length, 0)
  // Deleting twice is a no-op.
  assert.equal(await store.delete(link.token), false)
})

test('drops tokens whose payload disappeared', async () => {
  const redis = createRedis()
  const store = new ShareStore(redis, 'test')
  const link = await store.create('bot1', '123@g.us')
  // Simulate a partial write / manual key deletion.
  redis.strings.delete(`test:share:${link.token}`)
  assert.equal((await store.list('bot1', '123@g.us')).length, 0)
  assert.equal(redis.sets.get('test:share-group:bot1:123@g.us')?.size, 0)
})
