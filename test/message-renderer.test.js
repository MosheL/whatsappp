import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chatPreviewStatus,
  formatMessageText,
  hasLinkCandidate,
  albumCountLabel,
  isAlbumMessage,
  isForwardedMessage,
  isLocationMessage,
  isMaskedMessage,
  isOtpMessage,
  isUnsupportedMessage,
  canTranscribe,
  linkPreviewHref,
  linkPreviewHost,
  messageDeliveryState,
  messageReactions,
  groupedReactions,
  messagePreview,
  buildJidNameIndex,
  displayNameForJid,
  messageStatusTimestamp,
  messageReadBy,
  messageStatusTitle
} from '../web/src/message-renderer.js'
import { formatStatusTime } from '../web/src/helpers.js'

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

test('groups reactions per emoji with first names and mine flag', () => {
  const groups = groupedReactions({
    reactions: [
      { userJid: 'a', sender: 'moshe cohen', text: '👍', timestamp: 1 },
      { userJid: 'b', sender: 'arye levy', text: '👍', timestamp: 2 },
      { userJid: 'me', sender: 'אני', text: '🤦', timestamp: 3 }
    ]
  })
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0], { text: '👍', names: ['moshe', 'arye'], mine: false, showNames: true })
  assert.deepEqual(groups[1], { text: '🤦', names: ['אני'], mine: true, showNames: true })
})

test('hides reaction names at 3 or more distinct emojis', () => {
  const groups = groupedReactions({
    reactions: [
      { userJid: 'a', sender: 'a b', text: '👍', timestamp: 1 },
      { userJid: 'b', sender: 'b c', text: '❤️', timestamp: 2 },
      { userJid: 'c', sender: 'c d', text: '😮', timestamp: 3 }
    ]
  })
  assert.equal(groups.length, 3)
  assert.ok(groups.every(group => group.showNames === false))
  assert.deepEqual(groups.map(group => group.text), ['👍', '❤️', '😮'])
  assert.deepEqual(groupedReactions({ reactions: [] }), [])
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
  assert.equal(messagePreview({ type: 'orderMessage' }), 'הודעה לא נתמכת')
  // locationMessage is now a supported type — renders as 'מיקום'
  assert.equal(messagePreview({ type: 'locationMessage' }), 'מיקום')
  // A normal text message is not affected
  assert.equal(messagePreview({ type: 'conversation', text: 'hello' }), 'hello')
})

test('isLocationMessage detects locationMessage type', () => {
  assert.equal(isLocationMessage({ type: 'locationMessage' }), true)
  assert.equal(isLocationMessage({ type: 'liveLocationMessage' }), true)
  assert.equal(isLocationMessage({ type: 'conversation' }), false)
})

test('isLocationMessage detects location data even without the type field', () => {
  assert.equal(isLocationMessage({ location: { latitude: 32, longitude: 34 } }), true)
  assert.equal(isLocationMessage({}), false)
})

test('messagePreview shows location name when available', () => {
  const preview = messagePreview({
    type: 'locationMessage',
    location: { latitude: 32.0853, longitude: 34.7818, name: 'Azrieli Center' }
  })
  assert.equal(preview, 'מיקום: Azrieli Center')
})

test('messagePreview shows generic label when location has no name', () => {
  const preview = messagePreview({
    type: 'locationMessage',
    location: { latitude: 32.0853, longitude: 34.7818 }
  })
  assert.equal(preview, 'מיקום')
})

test('location message is not flagged as unsupported', () => {
  assert.equal(isUnsupportedMessage({ type: 'locationMessage', location: { latitude: 32, longitude: 34 } }), false)
})

test('location message without location data is still supported (known type)', () => {
  assert.equal(isUnsupportedMessage({ type: 'locationMessage' }), false)
})

test('OTP messages are supported and preview their verification code', () => {
  const message = {
    type: 'interactiveMessage',
    interactiveData: { type: 'interactive', body: '*123-456* הוא קוד האימות שלך' },
    otp: { code: '123-456', otpType: 'SMS' }
  }
  assert.equal(isUnsupportedMessage(message), false)
  assert.equal(isOtpMessage(message), true)
  assert.equal(messagePreview(message), 'קוד אימות: 123-456')
})

test('album placeholders render an album label and are never unsupported', () => {
  const album = { type: 'albumMessage', album: { imageCount: 2, videoCount: 1 } }
  assert.equal(isAlbumMessage(album), true)
  // stored before the album flag existed: the type alone is enough
  assert.equal(isAlbumMessage({ type: 'albumMessage' }), true)
  assert.equal(isAlbumMessage({ type: 'conversation', text: 'hi' }), false)
  assert.equal(isUnsupportedMessage(album), false)
  assert.equal(isUnsupportedMessage({ type: 'albumMessage' }), false)
  assert.equal(messagePreview(album), 'אלבום (2 תמונות, וידאו אחד)')
  assert.equal(albumCountLabel({ type: 'albumMessage' }), '')
  assert.equal(albumCountLabel({ album: { imageCount: 3, videoCount: 0 } }), '3 תמונות')
})

test('masked OTP messages (hidden by WhatsApp) render a dedicated notice and bump the chat', () => {
  const message = { type: 'placeholderMessage', masked: { business: 'Time' } }
  assert.equal(isMaskedMessage(message), true)
  // type-only fallback covers messages stored before the masked flag existed
  assert.equal(isMaskedMessage({ type: 'placeholderMessage' }), true)
  assert.equal(isMaskedMessage({ type: 'conversation', text: 'hi' }), false)
  assert.equal(isUnsupportedMessage(message), false)
  assert.equal(messagePreview(message), 'קוד אימות (מוסתר)')
})

test('monospace fences render literal code without nested markup', () => {
  const tokens = formatMessageText('run ```npm test``` now')
  const mono = tokens.find(token => token.type === 'mono')
  assert.equal(mono.text, 'npm test')
  assert.equal(tokens.map(token => token.text).join(''), 'run npm test now')

  // Content inside a fence is literal: *x* is not bold.
  assert.deepEqual(formatMessageText('```*not bold*```'), [{ type: 'mono', text: '*not bold*', bold: false, strike: false }])

  // Fences nest inside bold and inherit the flag.
  const nested = formatMessageText('*bold ```x``` end*').find(token => token.type === 'mono')
  assert.equal(nested.text, 'x')
  assert.equal(nested.bold, true)

  // Rendered HTML (chat-list preview) wraps the code element.
  assert.match(messagePreview({ text: 'use ```code``` here' }), /<code class="mono">code<\/code>/)

  // Unbalanced/in-line fence stays literal text.
  assert.equal(formatMessageText('a ```b').some(token => token.type === 'mono'), false)
  assert.equal(formatMessageText('``` ```').some(token => token.type === 'mono'), false)
})

test('normalizes receipt timestamps from seconds to milliseconds', () => {
  const message = { receipt: { userJid: 'two', receiptTimestamp: 1_700_000_000 } }
  assert.equal(messageStatusTimestamp(message), 1_700_000_000_000)
})

test('status timestamp prefers reads over delivery over the send time', () => {
  const sent = { timestamp: 1_700_000_000 }
  assert.equal(messageStatusTimestamp(sent), 1_700_000_000_000)
  assert.equal(messageStatusTimestamp({ ...sent, receipt: { receiptTimestamp: 1_700_000_010 } }), 1_700_000_010_000)
  assert.equal(messageStatusTimestamp({
    ...sent,
    receipt: { readTimestamp: 1_700_000_020 },
    userReceipt: [{ readTimestamp: 1_700_000_030 }]
  }), 1_700_000_030_000)
})

test('direct-chat status titles use the captured status update time', () => {
  // 1:1 updates arrive as { status, messageTimestamp } — no receipt objects.
  const now = Date.now()
  const message = { fromMe: true, timestamp: now - 5 * 60_000, status: 'read', statusTimestamp: now - 60_000 }
  assert.equal(messageStatusTimestamp(message), now - 60_000)
  assert.equal(messageStatusTitle(message, false, new Map()), formatStatusTime(now - 60_000))
  assert.notEqual(messageStatusTitle(message, false, new Map()), formatStatusTime(message.timestamp))
  // Receipt details win over the coarse status moment when present.
  assert.equal(messageStatusTimestamp({
    ...message,
    userReceipt: [{ userJid: 'two', readTimestamp: 1_700_000_900 }]
  }), 1_700_000_900_000)
})

test('builds a JID name index from contacts and group participants', () => {
  const contact = { jid: '972501234567@s.whatsapp.net', name: 'moshe cohen' }
  const index = buildJidNameIndex([contact, { jid: '972501234567@s.whatsapp.net', name: '972501234567' }, { jid: '972509999999@lid', name: 'דנה' }])
  assert.equal(displayNameForJid('972501234567@s.whatsapp.net', index), 'moshe cohen')
  assert.equal(displayNameForJid('972501234567@c.us', index), 'moshe cohen')
  assert.equal(displayNameForJid('972509999999@lid', index), 'דנה')
  assert.equal(displayNameForJid('972508888888@s.whatsapp.net', index), '+972508888888')
  // An unmapped LID must not be shown as a meaningless number.
  assert.equal(displayNameForJid('1234567890@lid', index), '')
})

test('lists group readers once, in receipt order', () => {
  const index = buildJidNameIndex([
    { jid: '972501111111@lid', name: 'דנה' },
    { jid: '972502222222@s.whatsapp.net', name: 'משה' }
  ])
  const message = {
    fromMe: true,
    userReceipt: [
      { userJid: '972502222222@s.whatsapp.net', readTimestamp: 1_700_000_000 },
      { userJid: '972501111111@lid', readTimestamp: 1_700_000_001, participantPn: '972501111111@s.whatsapp.net' },
      { userJid: '972503333333@s.whatsapp.net', receiptTimestamp: 1_700_000_002 }
    ]
  }
  assert.deepEqual(messageReadBy(message, index), ['משה', 'דנה'])
  assert.equal(messageStatusTitle(message, true, index), 'נקרא על ידי: משה, דנה')
  // Direct chats get the time/date of the status instead of a name list.
  assert.doesNotMatch(messageStatusTitle(message, false, index), /משה/)
  assert.equal(messageStatusTitle({ ...message, fromMe: false }, true, index), '')
  assert.equal(messageStatusTitle({ ...message, userReceipt: [] }, true, index), '')
})

test('caps a long group reader list in the tooltip', () => {
  const userReceipt = Array.from({ length: 8 }, (_, i) => ({
    userJid: `97250000${i}@s.whatsapp.net`,
    readTimestamp: 1_700_000_000 + i
  }))
  const title = messageStatusTitle({ fromMe: true, userReceipt }, true, new Map())
  assert.match(title, /^נקרא על ידי: /)
  assert.match(title, /ועוד 2$/)
})

test('keeps readers with the same display name as separate entries', () => {
  const index = buildJidNameIndex([
    { jid: '972501111111@s.whatsapp.net', name: 'דנה כהן' },
    { jid: '972501111112@s.whatsapp.net', name: 'דנה כהן' }
  ])
  const message = {
    fromMe: true,
    userReceipt: [
      { userJid: '972501111111@s.whatsapp.net', readTimestamp: 1 },
      { userJid: '972501111112@s.whatsapp.net', readTimestamp: 2 }
    ]
  }
  assert.deepEqual(messageReadBy(message, index), ['דנה כהן', 'דנה כהן'])
  assert.deepEqual(messageReadBy({ fromMe: true, userReceipt: [message.userReceipt[0]] }, index), ['דנה כהן'])
})

test('collapses a LID reader and its phone receipt into one participant', () => {
  const index = buildJidNameIndex([{ jid: '12345678901234@lid', name: 'דנה', phoneNumber: '972501111111' }])
  const message = {
    fromMe: true,
    userReceipt: [
      { userJid: '12345678901234@lid', readTimestamp: 1 },
      { userJid: '12345678901234@lid', readTimestamp: 2, participantPn: '972501111111@s.whatsapp.net' }
    ]
  }
  assert.deepEqual(messageReadBy(message, index), ['דנה'])
})

test('names unnamed readers by phone instead of the unknown placeholder', () => {
  const index = buildJidNameIndex([
    { jid: '972501111111@lid', name: 'Unknown participant', phoneNumber: '972501111111' },
    { jid: '972502222222@lid', name: 'Unknown participant', phoneNumber: '972502222222' }
  ])
  assert.equal(displayNameForJid('972501111111@lid', index), '+972501111111')
  const message = {
    fromMe: true,
    userReceipt: [
      { userJid: '972501111111@lid', readTimestamp: 1 },
      { userJid: '972502222222@lid', readTimestamp: 2 }
    ]
  }
  assert.deepEqual(messageReadBy(message, index), ['+972501111111', '+972502222222'])
  assert.match(messageStatusTitle(message, true, index), /\+972501111111, \+972502222222/)
  assert.doesNotMatch(messageStatusTitle(message, true, index), /Unknown/i)
})

test('canTranscribe covers voice notes, audio and video only', () => {
  assert.equal(canTranscribe({ media: { kind: 'audio' } }), true)
  assert.equal(canTranscribe({ media: { kind: 'ptt' } }), true)
  assert.equal(canTranscribe({ media: { kind: 'video' } }), true)
  assert.equal(canTranscribe({ media: { kind: 'image' } }), false)
  assert.equal(canTranscribe({ media: { kind: 'document' } }), false)
  assert.equal(canTranscribe({ type: 'conversation', text: 'hi' }), false)
  assert.equal(canTranscribe({ media: { kind: 'video' }, deleted: true }), false)
})
