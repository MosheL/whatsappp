// Shared message rendering helpers used by both App.vue and ChatThread.vue
// Extracted to eliminate duplication between the two components

/**
 * Build the media download URL for a message.
 */
export function mediaUrl(message, selectedBot) {
  return `/api/media?bot=${encodeURIComponent(selectedBot)}&jid=${encodeURIComponent(message.jid)}&id=${encodeURIComponent(message.id)}`
}

/**
 * Human-readable label for the media type.
 */
export function mediaLabel(message) {
  const prefix = message.viewOnce ? 'חד-פעמי: ' : ''
  const kind = mediaKind(message)
  if (kind === 'image') return `${prefix}תמונה`
  if (kind === 'video') return `${prefix}וידאו`
  if (kind === 'ptt') return `${prefix}הקלטה`
  if (kind === 'audio') return `${prefix}קול`
  if (kind === 'document') return `${prefix}מסמך`
  if (kind === 'sticker') return 'סטיקר'
  return `${prefix}מדיה`
}

/**
 * Determine the media kind from message data.
 */
export function mediaKind(message) {
  return message.media?.kind || message.viewOnceType || ''
}

/**
 * Guess media kind from MIME type.
 */
export function mediaKindFromMime(mimeType) {
  if (!mimeType) return ''
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return mimeType.includes('ogg') ? 'ptt' : 'audio'
  if (mimeType.startsWith('application/')) return 'document'
  return ''
}

/**
 * Whether the message has downloadable media.
 */
export function isDownloadableMedia(message) {
  if (message.viewOnce && !message.downloadable) return false
  return ['image', 'video', 'document', 'sticker', 'audio', 'ptt'].includes(mediaKind(message))
}

/**
 * Whether the media has been loaded into the component.
 */
export function loadedMediaUrl(message, loadedMedia) {
  return loadedMedia[message.id] || ''
}

/**
 * Get the file name for a media message.
 */
export function mediaFileName(message) {
  return message.media?.fileName || message.text || mediaLabel(message)
}

/**
 * CSS style for media preview (thumbnail background).
 */
export function mediaPreviewStyle(message) {
  const media = message.media || {}
  const width = Number(media.width || 0)
  const height = Number(media.height || 0)
  const style = {}
  if (width > 0 && height > 0) style.aspectRatio = `${width} / ${height}`
  if (media.thumbnail) {
    style.backgroundImage = `linear-gradient(rgba(8, 15, 20, 0.28), rgba(8, 15, 20, 0.38)), url("${media.thumbnail}")`
  }
  return style
}

/**
 * CSS style for media size (aspect ratio only).
 */
export function mediaSizeStyle(message) {
  const width = Number(message.media?.width || 0)
  const height = Number(message.media?.height || 0)
  return width > 0 && height > 0 ? { aspectRatio: `${width} / ${height}` } : {}
}

/**
 * Whether the message has a thumbnail preview.
 */
export function hasMediaPreview(message) {
  return Boolean(message.media?.thumbnail)
}

/**
 * Label for the media action button.
 */
export function mediaActionLabel(message) {
  return `טען ${mediaLabel(message)}`
}

/**
 * Get the sender number suffix for group messages.
 */
export function senderNumberLabel(message) {
  const number = String(message.senderNumber || '').replace(/[^\d]/g, '')
  if (!number || String(message.senderNumber || '').includes('@lid')) return ''
  return `@${number}`
}

/**
 * Whether a message is a call message.
 */
export function isCallMessage(message) {
  return message.type === 'callMessage' || Boolean(message.call)
}

/**
 * Whether a message is a contact (vCard) message.
 */
export function isContactMessage(message) {
  return message.type === 'contactMessage' || message.type === 'contactsArrayMessage' || Boolean(message.contact)
}

/**
 * Get the display name for a contact message.
 */
export function contactDisplayName(message) {
  return message?.contact?.displayName || message?.text || ''
}

/**
 * Whether a contact message has multiple contacts.
 */
export function hasMultipleContacts(message) {
  return Array.isArray(message?.contact?.contacts) && message.contact.contacts.length > 1
}

/**
 * Get the phone number from a contact message (first contact's phone).
 */
export function contactPhone(message) {
  return message?.contact?.phone || ''
}

/**
 * Get the phone number from a specific contact entry in a contacts array.
 */
export function contactEntryPhone(entry) {
  return entry?.phone || ''
}

/**
 * Check if a message was forwarded.
 */
export function isForwardedMessage(message) {
  return Boolean(message?.forwarded)
}

export function linkPreviewHref(message) {
  const value = String(message?.linkPreview?.url || message?.linkPreview?.matchedText || '')
  try {
    const url = new URL(value.startsWith('www.') ? `https://${value}` : value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

export function linkPreviewHost(message) {
  const href = linkPreviewHref(message)
  if (!href) return ''
  return new URL(href).hostname.replace(/^www\./, '')
}

export function linkPreviewImageStyle(preview) {
  const width = Number(preview?.thumbnailWidth || 0)
  const height = Number(preview?.thumbnailHeight || 0)
  return width > 0 && height > 0 ? { aspectRatio: `${width} / ${height}` } : {}
}

export function hasLinkCandidate(value) {
  return /(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:[^\s<>"']*)/i.test(String(value || ''))
}

/**
 * Determine delivery state for a message.
 */
export function messageDeliveryState(message, isGroupMessage, participantCount) {
  if (!message.fromMe || isCallMessage(message)) return 'delivered'
  const receipt = message.receipt || {}
  const receipts = Array.isArray(message.userReceipt) ? message.userReceipt : []
  const participantReceipts = receipts.filter(item => !item?.own)
  const status = message.status
  const statusText = String(status || '').toLowerCase()
  const hasReadReceipt = participantReceipts.some(item => item?.readTimestamp || item?.playedTimestamp)
  const hasDeliveryReceipt = participantReceipts.some(item => item?.receiptTimestamp || item?.deliveryTimestamp)
  const hasOwnReadReceipt = Boolean(receipt.own && (receipt.readTimestamp || receipt.playedTimestamp)) || receipts.some(item => item?.own && (item.readTimestamp || item.playedTimestamp))
  const receiptReadByOther = !receipt.own && (receipt.readTimestamp || receipt.playedTimestamp)
  const receiptDeliveredToOther = !receipt.own && (receipt.receiptTimestamp || receipt.deliveryTimestamp)
  const statusRead = (statusText.includes('read') || status === 4 || status === 5) && !hasOwnReadReceipt
  if (isGroupMessage) {
    const requiredReads = participantCount > 1 ? participantCount - 1 : 0
    // When participantCount is available and enough participants have read, show 'read'
    if (requiredReads && readReceiptCount(participantReceipts) >= requiredReads) return 'read'
    if (hasReadReceipt || hasDeliveryReceipt || receiptDeliveredToOther || statusRead || statusText.includes('deliver') || status === 3) return 'delivered'
    return 'sent'
  }
  if (receiptReadByOther || hasReadReceipt || statusRead) return 'read'
  if (receiptDeliveredToOther || hasDeliveryReceipt || statusText.includes('deliver') || status === 3) return 'delivered'
  if (statusText.includes('server_ack') || statusText.includes('sent') || status === 1 || status === 2) return 'sent'
  return 'sent'
}

function readReceiptCount(receipts) {
  const readUsers = new Set()
  for (const receipt of receipts) {
    if (receipt?.own) continue
    if (receipt?.readTimestamp || receipt?.playedTimestamp) {
      const userId = receipt?.userJid || receipt?.participant || receipt?.jid || ''
      if (userId) readUsers.add(userId)
    }
  }
  return readUsers.size
}

/**
 * Whether the message status icon should be shown.
 */
export function shouldShowMessageStatus(message) {
  if (isCallMessage(message)) return false
  return Boolean(message.fromMe)
}

/**
 * Whether the tick icon should be double (delivered or read).
 */
export function isDoubleTick(message, isGroupMessage, participantCount) {
  const state = messageDeliveryState(message, isGroupMessage, participantCount)
  return state === 'delivered' || state === 'read'
}

/**
 * Whether the user sent this reaction.
 */
export function isMyReaction(reaction) {
  return reaction.userJid === 'me' || reaction.sender === 'אני'
}

/**
 * Get deduplicated reactions for a message.
 */
export function messageReactions(message) {
  if (!Array.isArray(message.reactions)) return []
  const byUser = new Map()
  for (const reaction of message.reactions) {
    if (!reaction?.text) continue
    byUser.set(reactionUserKey(reaction), reaction)
  }
  return [...byUser.values()]
}

/**
 * Get a unique key for a reaction.
 */
export function reactionUserKey(reaction) {
  if (!reaction) return ''
  if (reaction.userJid === 'me' || reaction.sender === 'אני') return 'me'
  return reaction.userJid || reaction.participant || reaction.sender || ''
}

/**
 * Format message text with bold and links.
 */
export function formatMessageText(value) {
  const textValue = String(value || '')
  return formatInlineText(textValue, false)
}

function formatInlineText(textValue, bold) {
  if (!textValue) return []
  const tokens = []
  let cursor = 0

  while (cursor < textValue.length) {
    const open = textValue.indexOf('*', cursor)
    if (open < 0) {
      tokens.push(...linkifyText(textValue.slice(cursor), bold))
      break
    }
    const close = findBoldClose(textValue, open + 1)
    if (close < 0) {
      tokens.push(...linkifyText(textValue.slice(cursor), bold))
      break
    }
    tokens.push(...linkifyText(textValue.slice(cursor, open), bold))
    tokens.push(...linkifyText(textValue.slice(open + 1, close), true))
    cursor = close + 1
  }

  return tokens.filter(token => token.text)
}

function findBoldClose(textValue, from) {
  let close = textValue.indexOf('*', from)
  while (close >= 0) {
    const inner = textValue.slice(from, close)
    const next = textValue[close + 1] || ''
    if (inner.trim() && (!next || /[\s.,!?;:)\]}"']/.test(next))) return close
    close = textValue.indexOf('*', close + 1)
  }
  return -1
}

function linkifyText(textValue, bold) {
  const urlPattern = /\b(?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,!?;:)\]}]/gi
  // Match @[phone|name] structured mentions and plain @mention
  const mentionPattern = /@(?:\[(\d+)\|([^\]]+)\]|([^\s<>"']+))/gi
  const tokens = []
  let cursor = 0

  // Collect all matches sorted by position
  const matches = []
  for (const m of textValue.matchAll(urlPattern)) {
    matches.push({ type: 'url', index: m.index, length: m[0].length, url: m[0] })
  }
  for (const m of textValue.matchAll(mentionPattern)) {
    // m[1]=phone, m[2]=name (for @[phone|name]), m[3]=raw jid (for plain @mention)
    const isStructured = Boolean(m[1])
    matches.push({
      type: 'mention',
      index: m.index,
      length: m[0].length,
      text: isStructured ? m[2] : m[0],
      jid: isStructured ? m[1] : m[3],
      bold
    })
  }
  matches.sort((a, b) => a.index - b.index || b.length - a.length)

  for (const match of matches) {
    if (match.index < cursor) continue
    if (match.index > cursor) tokens.push({ type: bold ? 'bold' : 'text', text: textValue.slice(cursor, match.index) })
    if (match.type === 'url') {
      tokens.push({ type: 'link', text: match.url, href: match.url.startsWith('www.') ? `https://${match.url}` : match.url, bold })
    } else {
      tokens.push({ type: 'mention', text: match.text, jid: match.jid, bold })
    }
    cursor = match.index + match.length
  }

  if (cursor < textValue.length) tokens.push({ type: bold ? 'bold' : 'text', text: textValue.slice(cursor) })
  return tokens
}

/**
 * Short preview text for a message.
 */
function renderTokens(tokens) {
  return tokens.map(token => {
    if (token.type === 'bold') return `<b>${escapeHtml(token.text)}</b>`
    if (token.type === 'link') {
      const href = token.href || token.text
      const linkText = token.bold ? `<b>${escapeHtml(token.text)}</b>` : escapeHtml(token.text)
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${linkText}</a>`
    }
    if (token.type === 'mention') {
      const text = token.bold ? `<b>${escapeHtml(token.text)}</b>` : escapeHtml(token.text)
      return `<a href="#mention-${escapeHtml(token.jid)}" class="mention-link" data-jid="${escapeHtml(token.jid)}">${text}</a>`
    }
    return escapeHtml(token.text)
  }).join('')
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Check if a message has interactive data (templates, buttons, lists, etc.).
 */
export function isInteractiveMessage(message) {
  return Boolean(message?.interactiveData)
}

/**
 * Get the interactive type label for display.
 */
export function interactiveTypeLabel(message) {
  const data = message?.interactiveData
  if (!data) return ''
  if (data.type === 'template') return 'תבנית'
  if (data.type === 'buttons') return 'כפתורים'
  if (data.type === 'list') return 'רשימה'
  if (data.type === 'interactive') return 'הודעה אינטראקטיבית'
  return ''
}

/**
 * Short preview text for a message (returns HTML for text messages).
 */
export function messagePreview(message) {
  if (!message) return ''
  if (message.deleted) return 'הודעה נמחקה'
  if (message.viewOnce && !message.media?.kind) return mediaLabel(message)
  if (message.media?.kind) return mediaLabel(message)
  if (isContactMessage(message)) {
    return hasMultipleContacts(message) ? 'אנשי קשר' : 'איש קשר'
  }
  const text = message.text || message.type || ''
  return renderTokens(formatMessageText(text))
}

/**
 * Chat subtitle (address) for a chat.
 */
export function chatSubtitle(chat) {
  const address = chat.displayJid || chat.phoneNumber || chat.jid
  return chat.isMuted ? `${address} (x)` : address
}

/**
 * Chat title fallback.
 */
export function chatTitle(chat) {
  return chat?.name || chat?.jid || 'בחרו שיחה'
}

/**
 * Get initials for a chat avatar.
 */
export function initials(chat) {
  return (chat?.name || chat?.jid || '?').slice(0, 2)
}

/**
 * Preview text for a chat in the sidebar.
 */
export function chatPreview(chat) {
  return chat.lastMessage || ''
}

/**
 * Determine the tick status for a chat preview.
 * Returns 'read' (blue vv), 'delivered' (gray vv), or 'sent' (single gray tick).
 */
export function chatPreviewStatus(chat) {
  if (!chat.lastMessageFromMe) return ''
  return messageDeliveryState({
    fromMe: true,
    status: chat.lastMessageStatus,
    receipt: chat.lastMessageReceipt,
    userReceipt: chat.lastMessageUserReceipt
  }, Boolean(chat.isGroup), Number(chat.participantCount || 0))
}
