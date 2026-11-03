import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  messageCopyBody,
  messageCopyText,
  messagesCopyText,
  quotedCopyLine,
  senderLabel
} from '../web/src/message-copy.js'

test('labels own messages as אני and others by sender name', () => {
  assert.equal(senderLabel({ fromMe: true }), 'אני')
  assert.equal(senderLabel({ fromMe: false, sender: 'דני' }), 'דני')
  assert.equal(senderLabel({ fromMe: false }), 'לא ידוע')
})

test('adds the phone suffix for group participants only', () => {
  const message = { fromMe: false, sender: 'דני', senderNumber: '972501234567', jid: '1203@g.us' }
  assert.equal(senderLabel(message), 'דני (@972501234567)')
  assert.equal(senderLabel({ ...message, jid: '972501234567@s.whatsapp.net' }), 'דני')
  assert.equal(senderLabel({ ...message, sender: 'דני 972501234567' }), 'דני 972501234567')
})

test('describes non-text bubbles instead of copying nothing', () => {
  assert.equal(messageCopyBody({ media: { kind: 'image' } }), '[תמונה]')
  assert.equal(messageCopyBody({ call: { isVideo: true } }), 'שיחת וידאו')
  assert.equal(messageCopyBody({ call: {} }), 'שיחת קול')
  assert.equal(messageCopyBody({ deleted: true, text: 'old' }), 'הודעה נמחקה')
  assert.equal(messageCopyBody({ contact: { displayName: 'דני', phone: '050' } }), '[איש קשר] דני 050')
  assert.equal(messageCopyBody({ location: { name: 'בית', latitude: 1, longitude: 2 } }), '[מיקום] בית')
  assert.equal(messageCopyBody({ text: 'שלום' }), 'שלום')
})

test('prefixes the sender and includes the quoted message on request', () => {
  const message = {
    fromMe: true,
    text: 'בסדר',
    timestamp: Date.now(),
    quoted: { sender: 'דני', text: 'מה קורה?' }
  }
  assert.equal(messageCopyText(message), 'אני: בסדר')
  assert.equal(messageCopyText(message, { withQuote: true }), '↳ דני: מה קורה?\nאני: בסדר')
  assert.equal(messageCopyText(message, { withQuote: true, time: '14:32' }), '↳ דני: מה קורה?\n[14:32] אני: בסדר')
  assert.equal(messageCopyText(message, { body: 'בס' }), 'אני: בס')
})

test('quotes fall back to the quoted media kind', () => {
  assert.equal(quotedCopyLine({ sender: 'דני', mediaKind: 'תמונה' }), '↳ דני: [תמונה]')
  assert.equal(quotedCopyLine(null), '')
})

test('joins several selected messages and drops empty ones', () => {
  const entries = [
    { message: { fromMe: false, sender: 'דני', text: 'היי' }, options: { time: '10:00' } },
    { message: { fromMe: true, text: 'מה נשמע' }, options: { time: '10:01' } },
    { message: { fromMe: true }, options: {} }
  ]
  assert.equal(messagesCopyText(entries), '[10:00] דני: היי\n[10:01] אני: מה נשמע')
})
