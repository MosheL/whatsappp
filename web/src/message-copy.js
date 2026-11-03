// Copy-ready text for messages. Used by the message menu ("העתק") and by the
// thread selection copy, so a paste keeps the sender, the quote and the media
// context instead of a bare string of text.
import {
  mediaLabel, mediaKind, senderNumberLabel, isCallMessage, isContactMessage,
  contactDisplayName, contactPhone, isLocationMessage, isMaskedMessage, isAlbumMessage,
  isInteractiveMessage, isUnsupportedMessage, interactiveTypeLabel, albumCountLabel
} from './message-renderer.js'

// Label used for messages the user sent.
export const ME_LABEL = 'אני'
// Prefix that marks a quoted (replied-to) message block.
export const QUOTE_PREFIX = '↳'

function clean(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Display name of the message author: "אני" for own messages, the group
 * participant name otherwise (with the phone suffix when it adds information).
 */
export function senderLabel(message) {
  if (message?.fromMe) return ME_LABEL
  const name = clean(message?.sender)
  const number = senderNumberLabel(message || {})
  const digits = String(message?.senderNumber || '').replace(/\D/g, '')
  const isGroup = String(message?.jid || '').endsWith('@g.us')
  const withNumber = isGroup && number && digits && !name.includes(digits)
  if (name) return withNumber ? `${name} (${number})` : name
  return number || 'לא ידוע'
}

/**
 * One line describing a quoted message: `↳ דני: הטקסט שמצוטט`.
 */
export function quotedCopyLine(quoted) {
  if (!quoted) return ''
  const sender = clean(quoted.sender)
  const body = clean(quoted.text) || `[${clean(quoted.mediaKind) || 'מדיה'}]`
  return `${QUOTE_PREFIX} ${sender ? `${sender}: ` : ''}${body}`
}

/**
 * Body of a message: the text when there is one, otherwise a short
 * description of what the bubble shows (media, call, contact, location…).
 */
export function messageCopyBody(message) {
  if (!message) return ''
  if (message.deleted) return 'הודעה נמחקה'
  const text = String(message.text ?? '').trim()
  if (text) return text
  if (isCallMessage(message)) return message.call?.isVideo ? 'שיחת וידאו' : 'שיחת קול'
  if (isContactMessage(message)) {
    const name = clean(contactDisplayName(message))
    const phone = clean(contactPhone(message))
    return `[איש קשר] ${[name, phone].filter(Boolean).join(' ')}`.trim()
  }
  if (isLocationMessage(message) && message.location) {
    const loc = message.location
    const place = [clean(loc.name), clean(loc.address), clean(loc.url)].filter(Boolean).join(' - ')
    return place ? `[מיקום] ${place}` : '[מיקום]'
  }
  if (isMaskedMessage(message)) return 'קוד אימות מוסתר'
  if (isAlbumMessage(message)) {
    const counts = albumCountLabel(message)
    return counts ? `[אלבום] ${counts}` : '[אלבום]'
  }
  if (mediaKind(message) || message.viewOnce) return `[${mediaLabel(message)}]`
  if (message.transcript) return String(message.transcript).trim()
  if (isInteractiveMessage(message)) {
    const data = message.interactiveData || {}
    const body = clean(data.body) || clean(data.title) || interactiveTypeLabel(message) || 'הודעה אינטראקטיבית'
    return data.title && clean(data.body) ? `${clean(data.title)} - ${body}` : body
  }
  if (isUnsupportedMessage(message)) return message.type ? `הודעה לא נתמכת (${message.type})` : ''
  return ''
}

/**
 * Full copy block for a single message:
 *
 *   ↳ דני: ההודעה המקורית
 *   [14:32] אני: התשובה שלי
 *
 * `time` is only passed when copying several messages; `body` lets the caller
 * supply the exact (possibly partial) selected text; `withQuote` adds the
 * quoted message the bubble replies to.
 */
export function messageCopyText(message, { time = '', body = null, withQuote = false } = {}) {
  if (!message) return ''
  const quoted = withQuote === null ? Boolean(message.quoted) : Boolean(withQuote)
  const lines = []
  if (quoted && message.quoted) lines.push(quotedCopyLine(message.quoted))
  const content = body === null ? messageCopyBody(message) : String(body || '').trim()
  if (content) {
    const head = time ? `[${time}] ${senderLabel(message)}` : senderLabel(message)
    lines.push(`${head}: ${content}`)
  }
  return lines.join('\n')
}

/**
 * Copy text for a list of messages with their (optional) timestamps, joined by
 * newlines. Empty results are dropped so media-only selections stay tidy.
 */
export function messagesCopyText(entries) {
  return entries
    .map(entry => messageCopyText(entry.message, entry.options))
    .filter(Boolean)
    .join('\n')
}
