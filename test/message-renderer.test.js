import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chatPreviewStatus,
  hasLinkCandidate,
  isForwardedMessage,
  linkPreviewHref,
  linkPreviewHost,
  messageDeliveryState,
  messageReactions,
  messagePreview
} from '../web/src/message-renderer.js'

test('renders forwarded metadata from the public message flag', () => {
  assert.equal(isForwardedMessage({ forwarded: true }), true)
  assert.equal(isForwardedMessage({ forwarded: false }), false)
})

test('renders only safe web link previews', () => {
  assert.equal(linkPreviewHost({ linkPreview: { url: 'https://www.example.com/page' } }), 'example.com')
  assert.equal(linkPreviewHref({ linkPreview: { url: 'javascript:alert(1)' } }), '')
})

test('detects typed links before sending', () => {
  assert.equal(hasLinkCandidate('look at https://example.com/page'), true)
  assert.equal(hasLinkCandidate('look at example.com/page'), true)
  assert.equal(hasLinkCandidate('ordinary message'), false)
})

test('keeps reaction text payloads intact', () => {
  const reactions = messageReactions({
    reactions: [{ userJid: 'me', sender: 'me', text: 'ok', timestamp: 1 }]
  })
  assert.equal(reactions[0].text, 'ok')
})

test('escapes HTML in reply previews', () => {
  assert.equal(
    messagePreview({ text: '<img src=x onerror="alert(1)">' }),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  )
})

test('marks a group message read after every other participant reads it', () => {
  const message = {
    fromMe: true,
    userReceipt: [
      { userJid: 'one', readTimestamp: 1 },
      { userJid: 'two', readTimestamp: 1 }
    ]
  }
  assert.equal(messageDeliveryState(message, true, 3), 'read')
})

test('renders chat preview ticks from the shared delivery state', () => {
  assert.equal(chatPreviewStatus({ lastMessageFromMe: true, lastMessageStatus: 'sent' }), 'sent')
  assert.equal(chatPreviewStatus({ lastMessageFromMe: true, lastMessageStatus: 'delivered' }), 'delivered')
  assert.equal(chatPreviewStatus({ lastMessageFromMe: true, lastMessageStatus: 'read' }), 'read')
})

test('does not claim a group preview is delivered or read before its receipts arrive', () => {
  const chat = {
    isGroup: true,
    participantCount: 3,
    lastMessageFromMe: true,
    lastMessageStatus: 'sent'
  }
  assert.equal(chatPreviewStatus(chat), 'sent')

  chat.lastMessageUserReceipt = [{ userJid: 'one', receiptTimestamp: 1 }]
  assert.equal(chatPreviewStatus(chat), 'delivered')

  chat.lastMessageUserReceipt = [
    { userJid: 'one', readTimestamp: 1 },
    { userJid: 'two', readTimestamp: 1 }
  ]
  assert.equal(chatPreviewStatus(chat), 'read')
})

test('treats a legacy group read status without receipt details as delivered', () => {
  assert.equal(chatPreviewStatus({
    isGroup: true,
    participantCount: 3,
    lastMessageFromMe: true,
    lastMessageStatus: 4
  }), 'delivered')
})
