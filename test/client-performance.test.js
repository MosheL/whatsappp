import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequestPool } from '../web/src/request-pool.js'
import { createSearchIndexer, matchesSearch, searchQuery } from '../web/src/search-index.js'

test('concurrent GETs share work and completed responses are not cached', async () => {
  const pool = createRequestPool()
  let calls = 0
  let finish
  const fetcher = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  const first = pool.run('messages', { bot: 'bot1' }, fetcher)
  assert.equal(pool.run('messages', { bot: 'bot1' }, fetcher), first)
  await Promise.resolve()
  assert.equal(calls, 1)
  finish({ messages: [] })
  await first
  const second = pool.run('messages', { bot: 'bot1' }, fetcher)
  await Promise.resolve()
  assert.equal(calls, 2)
  finish({ messages: [] })
  await second
})

test('switching clients cancels only obsolete requests and permits a fresh request', async () => {
  const pool = createRequestPool()
  const signals = []
  const fetcher = signal => { signals.push(signal); return new Promise(() => {}) }
  pool.run('bot1', { bot: 'bot1' }, fetcher)
  pool.run('bot2', { bot: 'bot2' }, fetcher)
  await Promise.resolve()
  pool.cancel(scope => scope.bot !== 'bot2')
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  pool.run('bot1', { bot: 'bot1' }, fetcher)
  await Promise.resolve()
  assert.equal(signals[2].aborted, false)
})

test('search normalization survives receipt updates and refreshes after text edits', () => {
  const index = createSearchIndexer()
  const chat = { jid: '972501234567@s.whatsapp.net', name: 'משה', lastMessage: 'Hello world' }
  const entry = index(chat)
  chat.unread = 4
  chat.typing = 'someone'
  assert.equal(index(chat), entry)
  for (const query of ['משה', 'HELLO', '050-123-4567', '+972501234567']) {
    assert.equal(matchesSearch(entry, searchQuery(query)), true, query)
  }
  assert.equal(matchesSearch(entry, searchQuery('missing')), false)
  chat.lastMessage = 'Updated text'
  assert.notEqual(index(chat), entry)
  assert.equal(matchesSearch(index(chat), searchQuery('Updated')), true)
})

