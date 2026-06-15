import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeMessagePatch } from '../src/message-utils.ts'

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
