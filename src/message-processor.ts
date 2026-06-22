import type { WAMessage, WAMessageContent } from '@whiskeysockets/baileys/lib/Types/Message.js'
import type { MediaData, LinkPreviewData, ContactData, QuotedMessage, CallData, MessagePatch } from './types.ts'
import { displayPhoneForJidLike } from './contact-cache.ts'

// -------- Timestamp normalization --------

export function normalizeTimestamp(value: any): number {
  const raw = typeof value === 'object' && value?.low ? value.low : Number(value || 0)
  return raw > 10_000_000_000 ? raw : raw * 1000
}

// -------- Message content unwrapping --------

export function getMessageContent(message: WAMessageContent | null | undefined): WAMessageContent | null | undefined {
  const content =
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message?.documentWithCaptionMessage?.message ||
    message
  return content === message ? content : getMessageContent(content)
}

export function unwrapMessageForMedia(msg: WAMessage): WAMessage {
  const content = getMessageContent(msg.message)
  if (!content) return msg

  const type = messageType(content)
  const media = content[type]
  const normalizedContent = media && typeof media === 'object' && media.directPath && !('url' in media)
    ? { ...content, [type]: { ...media, url: '' } }
    : content

  return normalizedContent !== msg.message ? { ...msg, message: normalizedContent } : msg
}

// -------- View once --------

export function isViewOnceMessage(message: WAMessageContent | null | undefined): boolean {
  const content = getMessageContent(message)
  return Boolean(
    message?.viewOnceMessage ||
    message?.viewOnceMessageV2 ||
    message?.viewOnceMessageV2Extension ||
    content?.imageMessage?.viewOnce ||
    content?.videoMessage?.viewOnce ||
    content?.audioMessage?.viewOnce ||
    (message?.ephemeralMessage?.message && isViewOnceMessage(message.ephemeralMessage.message)) ||
    (message?.documentWithCaptionMessage?.message && isViewOnceMessage(message.documentWithCaptionMessage.message))
  )
}

export function isViewOnceBaileysMessage(msg: WAMessage): boolean {
  return Boolean((msg.key as any)?.isViewOnce || isViewOnceMessage(msg.message))
}

export function viewOnceKindFromType(type: string): string {
  if (type === 'imageMessage') return 'image'
  if (type === 'videoMessage') return 'video'
  if (type === 'audioMessage') return 'audio'
  if (type === 'documentMessage') return 'document'
  return ''
}

export function viewOnceLabel(kind = ''): string {
  if (kind === 'image') return 'חד-פעמי: תמונה'
  if (kind === 'video') return 'חד-פעמי: וידאו'
  if (kind === 'audio') return 'חד-פעמי: אודיו'
  if (kind === 'document') return 'חד-פעמי: קובץ'
  return 'הודעה חד-פעמית'
}

// -------- Message text --------

export function messageText(message: WAMessageContent | null | undefined): string {
  const content = getMessageContent(message)
  if (!content) return ''
  const type = messageType(message)
  // Contact messages have no actual text content — displayName is metadata, shown in contact block
  if (content.contactMessage || content.contactsArrayMessage) return ''

  // Template / buttons / list / interactive messages: extract body text
  if (content.templateMessage) {
    const tm = content.templateMessage
    const h4rt = tm.hydratedFourRowTemplate || tm.hydratedTemplate
    if (h4rt) return h4rt.hydratedContentText || h4rt.hydratedTitleText || ''
    if (tm.fourRowTemplate) {
      const frt = tm.fourRowTemplate
      return frt.content?.text || frt.footer?.text || ''
    }
    return ''
  }
  if (content.buttonsMessage) {
    return content.buttonsMessage.description || content.buttonsMessage.title || ''
  }
  if (content.listMessage) {
    return content.listMessage.description || content.listMessage.title || ''
  }
  if (content.interactiveMessage) {
    return content.interactiveMessage.body?.text || content.interactiveMessage.header?.title || ''
  }

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.documentMessage?.fileName ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    (isViewOnceMessage(message) ? viewOnceLabel(viewOnceKindFromType(type)) : '') ||
    (content.secretEncryptedMessage ? 'הודעה מוצפנת' : '') ||
    ''
  )
}

// -------- Message type --------

export function messageType(message: WAMessageContent | null | undefined): string {
  const content = getMessageContent(message)
  if (!content) return 'unknown'
  const preferredTypes = [
    'conversation',
    'extendedTextMessage',
    'imageMessage',
    'videoMessage',
    'documentMessage',
    'audioMessage',
    'stickerMessage',
    'buttonsResponseMessage',
    'listResponseMessage',
    'templateButtonReplyMessage',
    'contactMessage',
    'contactsArrayMessage'
  ]
  const preferred = preferredTypes.find(type => content[type])
  if (preferred) return preferred
  return Object.keys(content)[0] || 'unknown'
}

// -------- Media --------

export function jpegThumbnailDataUrl(thumbnail: any): string {
  if (!thumbnail) return ''
  if (typeof thumbnail === 'string') {
    if (thumbnail.startsWith('data:image/')) return thumbnail
    return `data:image/jpeg;base64,${thumbnail}`
  }
  if (Buffer.isBuffer(thumbnail) || thumbnail instanceof Uint8Array || Array.isArray(thumbnail)) {
    return `data:image/jpeg;base64,${Buffer.from(thumbnail).toString('base64')}`
  }
  return ''
}

export function messageMedia(message: WAMessageContent | null | undefined, type: string): MediaData | undefined {
  const content = getMessageContent(message)
  const media = content?.[type]
  if (!media) return undefined
  if (type === 'imageMessage' || type === 'videoMessage' || type === 'documentMessage' || type === 'stickerMessage' || type === 'audioMessage') {
    const thumbnail = jpegThumbnailDataUrl(media.jpegThumbnail)
    return {
      kind: type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : type === 'stickerMessage' ? 'sticker' : type === 'audioMessage' ? 'audio' : 'document',
      mimetype: media.mimetype || (type === 'imageMessage' ? 'image/jpeg' : type === 'videoMessage' ? 'video/mp4' : type === 'stickerMessage' ? 'image/webp' : type === 'audioMessage' ? 'audio/ogg' : 'application/octet-stream'),
      caption: media.caption || '',
      fileName: media.fileName || media.title || '',
      thumbnail,
      width: Number(media.width || 0) || undefined,
      height: Number(media.height || 0) || undefined,
      url: ''
    }
  }
  return undefined
}

/** Extract display name from a vCard string (FN field) */
export function displayNameFromVcard(vcard?: string | null): string {
  if (!vcard) return ''
  const lines = vcard.split(/[\r\n]+/)
  // Try to find FN line (display name in vCard)
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^FN/i.test(trimmed)) {
      const value = trimmed.split(':')[1]?.trim() || ''
      if (value) return value
    }
  }
  // Fallback: try N field (structured name)
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^N/i.test(trimmed)) {
      const parts = trimmed.split(':')[1]?.split(';').filter(Boolean) || []
      // N format: Family;Given;Additional;Prefix;Suffix
      const given = parts[1] || ''
      const family = parts[0] || ''
      if (given && family) return `${family} ${given}`.trim()
      if (given) return given
      if (family) return family
    }
  }
  return ''
}

/** Extract phone number from a vCard string */
export function phoneFromVcard(vcard?: string | null): string {
  if (!vcard) return ''
  const lines = vcard.split(/[\r\n]+/)
  // Try to find any line containing TEL (case-insensitive)
  const telLine = lines.find(line => /^.*TEL/i.test(line.trim()))
  if (!telLine) return ''
  // Prefer waid parameter (WhatsApp ID) which gives the clean number
  const waidMatch = telLine.match(/waid=(\d+)/)
  if (waidMatch) return waidMatch[1]
  // Otherwise extract all digits from the number part after the colon
  const numPart = telLine.split(':')[1] || ''
  const digits = numPart.replace(/[^\d]/g, '')
  return digits || ''
}

export function messageContact(message: WAMessageContent | null | undefined, type: string): ContactData | undefined {
  const content = getMessageContent(message)

  // Handle single contact (contactMessage) — also check contactsArrayMessage with 1 item
  if (type === 'contactMessage' || (type === 'contactsArrayMessage' && content?.contactsArrayMessage?.contacts?.length === 1)) {
    let displayName = ''
    let vcard: string | undefined
    // Try contactMessage first, then fall back to contactsArrayMessage with single item
    const directContact = content?.contactMessage
    if (directContact) {
      displayName = directContact.displayName || ''
      vcard = directContact.vcard || undefined
    }
    // If no direct contact data, try extracting from contactsArrayMessage (WhatsApp may echo as this)
    if (!displayName && !vcard) {
      const arrContacts = content?.contactsArrayMessage?.contacts
      if (arrContacts?.length === 1) {
        const single = arrContacts[0]
        displayName = single.displayName || ''
        vcard = single.vcard || undefined
      }
    }
    // Extract from vCard FN field as last resort
    if (!displayName) {
      displayName = displayNameFromVcard(vcard)
    }
    // Return undefined only if we have absolutely nothing to show
    if (!displayName && !vcard) return undefined
    return {
      displayName,
      vcard,
      phone: phoneFromVcard(vcard) || undefined
    }
  }
  if (type === 'contactsArrayMessage') {
    const contacts = content?.contactsArrayMessage
    const contactList = contacts?.contacts || []
    if (!contactList.length && !contacts?.displayName) return undefined
    const items = contactList.map(c => ({
      displayName: c.displayName || '',
      vcard: c.vcard || undefined,
      phone: phoneFromVcard(c.vcard) || undefined
    }))
    return {
      displayName: contacts?.displayName || items.map(c => c.displayName).filter(Boolean).join(', '),
      contacts: items.length ? items : undefined
    }
  }
  return undefined
}

export function messageLinkPreview(message: WAMessageContent | null | undefined): LinkPreviewData | undefined {
  const preview = getMessageContent(message)?.extendedTextMessage
  const matchedText = String(preview?.matchedText || '')
  const title = String(preview?.title || '')
  if (!matchedText || !title) return undefined
  return {
    url: matchedText,
    matchedText,
    title,
    description: String(preview?.description || '') || undefined,
    thumbnail: jpegThumbnailDataUrl(preview?.jpegThumbnail) || undefined,
    thumbnailWidth: Number(preview?.thumbnailWidth || 0) || undefined,
    thumbnailHeight: Number(preview?.thumbnailHeight || 0) || undefined
  }
}

// -------- Interactive message extraction (templates, buttons, lists, interactive) --------

import type { InteractiveData, InteractiveButton, InteractiveSection, InteractiveRow } from './types.ts'

/**
 * Extract interactive data from a template message.
 */
export function messageTemplateData(content: any): InteractiveData | undefined {
  if (!content?.templateMessage) return undefined
  const tm = content.templateMessage

  // Helper: extract button text from a HighlyStructuredMessage (which has .text or .hydratedHsm)
  function hsmText(hsm: any): string {
    if (!hsm) return ''
    return hsm.text || (hsm.hydratedHsm?.hydratedContentText) || ''
  }

  // Helper: extract button info from hydrated or non-hydrated button objects
  function extractButton(b: any): InteractiveButton | null {
    // Hydrated buttons (hydratedFourRowTemplate)
    const hqr = b.quickReplyButton
    if (hqr) return { text: hqr.displayText || '', id: hqr.id || '', type: 'quick_reply' }
    const hur = b.urlButton
    if (hur) return { text: hur.displayText || '', url: hur.url || '', type: 'url' }
    const hca = b.callButton
    if (hca) return { text: hca.displayText || '', phone: hca.phoneNumber || '', type: 'call' }

    // Non-hydrated buttons (fourRowTemplate) — displayText is a HighlyStructuredMessage
    const qr = b.quickReplyButton
    if (qr) return { text: hsmText(qr.displayText), id: qr.id || '', type: 'quick_reply' }
    const ur = b.urlButton
    if (ur) return { text: hsmText(ur.displayText), url: hsmText(ur.url), type: 'url' }
    const ca = b.callButton
    if (ca) return { text: hsmText(ca.displayText), phone: hsmText(ca.phoneNumber), type: 'call' }

    return null
  }

  // Hydrated four-row template
  const h4rt = tm.hydratedFourRowTemplate || tm.hydratedTemplate
  if (h4rt) {
    const buttons: InteractiveButton[] = (h4rt.hydratedButtons || []).map(extractButton).filter((b): b is InteractiveButton => b !== null && !!b.text)
    return {
      type: 'template',
      title: h4rt.hydratedTitleText || '',
      body: h4rt.hydratedContentText || '',
      footer: h4rt.hydratedFooterText || '',
      buttons: buttons.length ? buttons : undefined
    }
  }

  // Four-row template (non-hydrated)
  const frt = tm.fourRowTemplate
  if (frt) {
    const buttons: InteractiveButton[] = (frt.buttons || []).map(extractButton).filter((b): b is InteractiveButton => b !== null && !!b.text)
    return {
      type: 'template',
      title: '',
      body: hsmText(frt.content) || '',
      footer: hsmText(frt.footer) || '',
      buttons: buttons.length ? buttons : undefined
    }
  }

  return undefined
}

/**
 * Extract interactive data from a buttons message.
 */
export function messageButtonsData(content: any): InteractiveData | undefined {
  if (!content?.buttonsMessage) return undefined
  const bm = content.buttonsMessage
  const buttons: InteractiveButton[] = (bm.buttons || []).map((b: any) => {
    const text = b.buttonText?.text || ''
    const id = b.buttonId || ''
    // Determine button action type
    let type = 'quick_reply'
    let url = ''
    if (b.nativeFlowInfo?.url) {
      type = 'url'
      url = b.nativeFlowInfo.url
    }
    return { text, type, url, id }
  }).filter((b: InteractiveButton) => b.text)
  return {
    type: 'buttons',
    title: bm.text || '',
    body: bm.contentText || '',
    footer: bm.footerText || '',
    buttons: buttons.length ? buttons : undefined
  }
}

/**
 * Extract interactive data from a list message.
 */
export function messageListData(content: any): InteractiveData | undefined {
  if (!content?.listMessage) return undefined
  const lm = content.listMessage
  const sections: InteractiveSection[] = (lm.sections || []).map((s: any) => ({
    title: s.title || '',
    rows: (s.rows || []).map((r: any) => ({
      title: r.title || '',
      description: r.description || '',
      rowId: r.rowId || ''
    })).filter((r: InteractiveRow) => r.title)
  })).filter((s: InteractiveSection) => s.rows.length)
  return {
    type: 'list',
    title: lm.title || '',
    body: lm.description || '',
    footer: lm.footerText || '',
    buttonText: lm.buttonText || '',
    sections: sections.length ? sections : undefined
  }
}

/**
 * Extract interactive data from an interactive message (native flow / shop / collection / carousel).
 */
/**
 * Extract interactive data from an interactive message (native flow / shop / collection / carousel).
 */
export function messageInteractiveMsgData(content: any): InteractiveData | undefined {
  if (!content?.interactiveMessage) return undefined
  const im = content.interactiveMessage
  const header = im.header?.title || ''
  const body = im.body?.text || ''
  const footer = im.footer?.text || ''

  // Native flow message (modern buttons)
  if (im.nativeFlowMessage) {
    const buttons: InteractiveButton[] = (im.nativeFlowMessage.buttons || []).map((b: any) => ({
      text: b.name || '',
      id: b.buttonParamsJson || ''
    })).filter((b: InteractiveButton) => b.text)
    return {
      type: 'interactive',
      title: header,
      body,
      footer,
      buttons: buttons.length ? buttons : undefined
    }
  }

  // Shop / collection / carousel — just show the body/header as text
  if (im.shopStorefrontMessage || im.collectionMessage || im.carouselMessage) {
    return {
      type: 'interactive',
      title: header,
      body,
      footer
    }
  }

  // Fallback: show body/header as plain text
  if (body || header) {
    return {
      type: 'interactive',
      title: header,
      body,
      footer
    }
  }

  return undefined
}

/**
 * Extract interactive data from any content. Checks template > buttons > list > interactive.
 */
export function messageInteractiveData(content: any): InteractiveData | undefined {
  return messageTemplateData(content) || messageButtonsData(content) || messageListData(content) || messageInteractiveMsgData(content)
}

// -------- Message context (quotes) --------

export function messageContext(message: WAMessageContent | null | undefined): Record<string, any> | null | undefined {
  const content = getMessageContent(message)
  const type = messageType(message)
  return content?.[type]?.contextInfo || content?.extendedTextMessage?.contextInfo || content?.contextInfo
}

export function isForwardedMessage(message: WAMessageContent | null | undefined): boolean {
  return Number(messageContext(message)?.forwardingScore || 0) > 0
}

export function quotedFromIncomingMessage(msg: WAMessage): QuotedMessage | undefined {
  const context = messageContext(msg.message)
  if (!context?.quotedMessage || !context?.stanzaId) return undefined
  const quotedText = messageText(context.quotedMessage)
  const quotedType = messageType(context.quotedMessage)
  const quotedMedia = messageMedia(context.quotedMessage, quotedType)
  return {
    id: context.stanzaId,
    sender: context.participant ? displayPhoneForJidLike(context.participant) || context.participant : '',
    text: quotedText,
    mediaKind: quotedMedia?.kind || viewOnceKindFromType(quotedType) || (quotedType === 'stickerMessage' ? 'sticker' : undefined)
  }
}

// -------- Call --------

export function callOutcomeLabel(value: number | string | undefined | null): string {
  const text = String(value ?? '').toLowerCase()
  if (value === 0 || text.includes('connected')) return 'הסתיימה'
  if (value === 1 || text.includes('missed')) return 'לא נענתה'
  if (value === 2 || text.includes('failed')) return 'נכשלה'
  if (value === 3 || text.includes('reject')) return 'נדחתה'
  if (value === 4 || text.includes('accepted_elsewhere')) return 'נענתה במכשיר אחר'
  if (value === 5 || text.includes('ongoing')) return 'פעילה'
  if (value === 6 || text.includes('dnd')) return 'הושתקה'
  if (value === 7 || text.includes('unknown')) return 'הושתקה ממספר לא מוכר'
  return ''
}

export function callTypeLabel(isVideo?: boolean): string {
  return isVideo ? 'שיחת וידאו' : 'שיחה קולית'
}

export function formatCallDuration(seconds: number | undefined | null): string {
  const total = typeof seconds === 'object' && seconds?.low ? seconds.low : Number(seconds || 0)
  if (!total) return ''
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest} שניות`
}

export function callInfoFromMessage(msg: WAMessage): { id: string; text: string; call: CallData } | undefined {
  const content = getMessageContent(msg.message)
  const log = content?.callLogMesssage || content?.callLogMessage
  if (log) {
    const outcome = callOutcomeLabel(log.callOutcome)
    const duration = formatCallDuration(log.durationSecs)
    const details = [outcome, duration].filter(Boolean).join(', ')
    return {
      id: msg.key.id || `call:${normalizeTimestamp(msg.messageTimestamp)}`,
      text: details ? `${callTypeLabel(log.isVideo)} - ${details}` : callTypeLabel(log.isVideo),
      call: {
        id: msg.key.id || '',
        status: outcome || 'log',
        isVideo: Boolean(log.isVideo),
        durationSecs: typeof log.durationSecs === 'object' && log.durationSecs?.low ? log.durationSecs.low : Number(log.durationSecs || 0),
        outcome: log.callOutcome
      }
    }
  }

  const stubType = (msg as any).messageStubType
  const isMissedCall = [40, 41, 45, 46, 'CALL_MISSED_VOICE', 'CALL_MISSED_VIDEO', 'CALL_MISSED_GROUP_VOICE', 'CALL_MISSED_GROUP_VIDEO'].includes(stubType)
  if (!isMissedCall) return
  const isVideo = stubType === 41 || stubType === 46 || stubType === 'CALL_MISSED_VIDEO' || stubType === 'CALL_MISSED_GROUP_VIDEO'
  return {
    id: msg.key.id || `call:${normalizeTimestamp(msg.messageTimestamp)}`,
    text: `${callTypeLabel(isVideo)} - לא נענתה`,
    call: {
      id: msg.key.id || '',
      status: 'missed',
      isVideo,
      outcome: 'missed'
    }
  }
}

// -------- Patch from content --------

export function messagePatchFromContent(message: WAMessageContent | null | undefined): MessagePatch {
  const type = messageType(message)
  const text = messageText(message)
  const media = messageMedia(message, type)
  const linkPreview = messageLinkPreview(message)
  const contact = messageContact(message, type)
  const interactiveData = messageInteractiveData(message)
  const patch: Record<string, any> = { edited: true, forwarded: isForwardedMessage(message) }
  if (type !== 'unknown') patch.type = type
  if (text || media || contact) patch.text = text
  if (media) patch.media = media
  if (linkPreview) patch.linkPreview = linkPreview
  if (contact) patch.contact = contact
  if (interactiveData) patch.interactiveData = interactiveData
  return patch
}

// -------- Transport message detection --------

export function isTransportMessage(type: string) {
  return [
    'senderKeyDistributionMessage',
    'protocolMessage',
    'deviceSentMessage',
    'messageContextInfo',
    'keepInChatMessage',
    'reactionMessage',
    'pollUpdateMessage'
  ].includes(type)
}
