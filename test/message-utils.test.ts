import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeMessagePatch, isMessageEditable, messageStatusRank, MESSAGE_EDIT_WINDOW_MS } from '../src/message-utils.ts'

test('isMessageEditable only allows recent outgoing text messages', () => {
  const now = 1_700_000_000_000
  const base = { fromMe: true, deleted: false, text: 'hi', timestamp: now - 1000 }
  assert.equal(isMessageEditable(base, now), true)
  // On the window boundary it is still editable; one ms past it is not.
  assert.equal(isMessageEditable({ ...base, timestamp: now - MESSAGE_EDIT_WINDOW_MS }, now), true)
  assert.equal(isMessageEditable({ ...base, timestamp: now - MESSAGE_EDIT_WINDOW_MS - 1 }, now), false)
  assert.equal(isMessageEditable({ ...base, fromMe: false }, now), false)
  assert.equal(isMessageEditable({ ...base, deleted: true }, now), false)
  assert.equal(isMessageEditable({ ...base, text: '' }, now), false)
  assert.equal(isMessageEditable({ ...base, timestamp: 0 }, now), false)
  assert.equal(isMessageEditable(null, now), false)
})

test('does not regress message delivery status during duplicate upserts', () => {
  const existing: any = { id: 'message', status: 'read', userReceipt: [{ userJid: 'one', readTimestamp: 1 }] }
  const duplicate: any = { id: 'message', status: 'sent', userReceipt: [{ userJid: 'two', receiptTimestamp: 1 }] }

  const merged = mergeMessagePatch(existing, duplicate)

  assert.equal(merged.status, 'read')
  assert.deepEqual(merged.userReceipt, [
    { userJid: 'one', readTimestamp: 1 },
    { userJid: 'two', receiptTimestamp: 1 }
  ])
})

test('an empty-text reaction patch removes the reaction (un-react)', () => {
  const existing: any = {
    id: 'message',
    reactions: [
      { userJid: 'me', sender: 'אני', text: '👍', timestamp: 1 },
      { userJid: 'other', sender: 'Other', text: '👍', timestamp: 2 }
    ]
  }

  // Tapping my own reaction sends an empty emoji — the removal patch
  const removed = mergeMessagePatch(existing, {
    reaction: { userJid: 'me', sender: 'אני', text: '', timestamp: 3 }
  })

  assert.equal(removed.reactions.length, 1)
  assert.equal(removed.reactions[0].userJid, 'other')
})

test('keeps the status moment of the furthest state when updates reorder', () => {
  const existing: any = { id: 'message', status: 3, statusTimestamp: 1_700_000_100_000 }

  // A later status advances the moment.
  const read = mergeMessagePatch(existing, { status: 4, statusTimestamp: 1_700_000_200_000 })
  assert.equal(read.status, 4)
  assert.equal(read.statusTimestamp, 1_700_000_200_000)

  // A stale delivery update must not rewind the (already read) moment.
  const stale = mergeMessagePatch(read, { status: 3, statusTimestamp: 1_700_000_050_000 })
  assert.equal(stale.status, 4)
  assert.equal(stale.statusTimestamp, 1_700_000_200_000)

  // Duplicate updates keep the newest moment.
  const duplicate = mergeMessagePatch(read, { status: 'read', statusTimestamp: 1_700_000_150_000 })
  assert.equal(duplicate.statusTimestamp, 1_700_000_200_000)
  assert.equal(messageStatusRank(duplicate.status), 4)

  // Patches without a moment leave the stored one alone.
  assert.equal(mergeMessagePatch(read, { edited: true }).statusTimestamp, 1_700_000_200_000)
})
