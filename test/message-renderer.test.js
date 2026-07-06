import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chatPreviewStatus,
  formatMessageText,
  hasLinkCandidate,
  isForwardedMessage,
  isUnsupportedMessage,
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

test('renders ~text~ as strikethrough', () => {
  const tokens = formatMessageText('hello ~world~ end')
  assert.deepEqual(tokens, [
    { type: 'text', text: 'hello ', bold: false, strike: false },
    { type: 'text', text: 'world', bold: false, strike: true },
    { type: 'text', text: ' end', bold: false, strike: false }
  ])
  assert.equal(messagePreview({ text: 'hello ~world~ end' }), 'hello <del>world</del> end')
})

test('combines bold and strikethrough when both markers wrap a span', () => {
  const tokens = formatMessageText('*a ~b~ c*')
  assert.equal(tokens.length, 3)
  assert.equal(tokens[0].text, 'a ')
  assert.equal(tokens[0].bold, true)
  assert.equal(tokens[0].strike, false)
  assert.equal(tokens[1].text, 'b')
  assert.equal(tokens[1].bold, true)
  assert.equal(tokens[1].strike, true)
  assert.equal(tokens[2].text, ' c')
  assert.equal(tokens[2].bold, true)
  assert.equal(tokens[2].strike, false)
  // <b> wraps <del> so the bold weight is preserved while the line-through stays.
  assert.equal(
    messagePreview({ text: '*a ~b~ c*' }),
    '<b>a </b><b><del>b</del></b><b> c</b>'
  )
})

test('does not nest the same inline marker twice', () => {
  // The outer strike spans `one ~two`. The dangling closing ~ at the very end
  // has no pair to close it, so the trailing `three~` stays plain — mirroring
  // WhatsApp's behavior of ignoring unmatched markers.
  const tokens = formatMessageText('~one ~two~ three~')
  assert.deepEqual(tokens, [
    { type: 'text', text: 'one ~two', bold: false, strike: true },
    { type: 'text', text: ' three~', bold: false, strike: false }
  ])
})

test('detects plain email addresses and renders mailto links', () => {
  const tokens = formatMessageText('mail me at user@example.com today')
  const email = tokens.find(token => token.type === 'email')
  assert.ok(email, 'expected an email token')
  assert.equal(email.text, 'user@example.com')
  assert.equal(email.href, 'mailto:user@example.com')
  assert.equal(email.bold, false)
  // The email must not be matched as a mention.
  assert.equal(tokens.some(token => token.type === 'mention'), false)
  assert.equal(messagePreview({ text: 'user@example.com' }), '<a href="mailto:user@example.com" target="_blank" rel="noopener">user@example.com</a>')
})

test('handles complex emails with dots, plus tags and multi-segment TLDs', () => {
  const tokens = formatMessageText('a.b+tag@example.co.uk')
  assert.equal(tokens[0].type, 'email')
  assert.equal(tokens[0].text, 'a.b+tag@example.co.uk')
  assert.equal(tokens[0].href, 'mailto:a.b+tag@example.co.uk')
})

test('does not mistake a plain phone @mention for an email', () => {
  const tokens = formatMessageText('hi @972501234567')
  const mention = tokens.find(token => token.type === 'mention')
  assert.ok(mention, 'expected a mention token')
  assert.equal(mention.jid, '972501234567')
  assert.equal(tokens.some(token => token.type === 'email'), false)
})

test('renders wa.me and chat.whatsapp.com without http as https links', () => {
  const tokens = formatMessageText('join chat.whatsapp.com/ABCDEF12 or wa.me/972501234567')
  const links = tokens.filter(token => token.type === 'link')
  assert.equal(links.length, 2)
  assert.equal(links[0].text, 'chat.whatsapp.com/ABCDEF12')
  assert.equal(links[0].href, 'https://chat.whatsapp.com/ABCDEF12')
  assert.equal(links[1].text, 'wa.me/972501234567')
  assert.equal(links[1].href, 'https://wa.me/972501234567')
  assert.equal(
    messagePreview({ text: 'wa.me/972501234567' }),
    '<a href="https://wa.me/972501234567" target="_blank" rel="noopener">wa.me/972501234567</a>'
  )
})

test('lets a schema-prefixed WhatsApp link keep its original scheme', () => {
  const tokens = formatMessageText('see https://wa.me/972501234567')
  const link = tokens.find(token => token.type === 'link')
  assert.equal(link.href, 'https://wa.me/972501234567')
})

test('flags an unsupported message type with no renderable content', () => {
  assert.equal(isUnsupportedMessage({ type: 'locationMessage' }), true)
  assert.equal(isUnsupportedMessage({ type: 'orderMessage' }), true)
  assert.equal(isUnsupportedMessage({ type: 'productMessage' }), true)
  assert.equal(isUnsupportedMessage({ type: 'groupInviteMessage' }), true)
  assert.equal(isUnsupportedMessage({ type: 'eventMessage' }), true)
})

test('does not flag messages with renderable content as unsupported', () => {
  // Text message
  assert.equal(isUnsupportedMessage({ type: 'conversation', text: 'hi' }), false)
  // Media message of an unsupported type still has renderable media
  assert.equal(isUnsupportedMessage({ type: 'locationMessage', media: { kind: 'image' } }), false)
  // Interactive message
  assert.equal(isUnsupportedMessage({ type: 'interactiveMessage', interactiveData: { type: 'interactive' } }), false)
  // Call message
  assert.equal(isUnsupportedMessage({ type: 'callMessage', call: { id: '1', status: 'missed', isVideo: false } }), false)
  // Unknown type with text
  assert.equal(isUnsupportedMessage({ type: 'unknown', text: 'hi' }), false)
})

test('deleted messages are never unsupported (they have their own placeholder)', () => {
  assert.equal(isUnsupportedMessage({ type: 'locationMessage', deleted: true }), false)
})

test('renders the unsupported placeholder in the chat preview', () => {
  assert.equal(messagePreview({ type: 'locationMessage' }), 'הודעה לא נתמכת')
  assert.equal(messagePreview({ type: 'orderMessage' }), 'הודעה לא נתמכת')
  // A normal text message is not affected
  assert.equal(messagePreview({ type: 'conversation', text: 'hello' }), 'hello')
})
