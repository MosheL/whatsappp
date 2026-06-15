import type { Contact } from '@whiskeysockets/baileys/lib/Types/Contact.js'
import { isJidGroup } from '@whiskeysockets/baileys'
import type { UiChat, UiMessage, ContactCacheDeps } from './types.ts'

const TYPING_EXPIRY_MS = 10_000

// -------- Pure utility functions (no dependencies) --------

export function isLidJid(jid?: string | null): boolean {
  return Boolean(jid?.endsWith('@lid'))
}

export function shouldIgnoreChatJid(jid?: string | null): boolean {
  return !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')
}

export function shouldIgnoreUiJid(jid?: string | null): boolean {
  return shouldIgnoreChatJid(jid) || isLidJid(jid)
}

export function normalizePhoneJid(value?: string | null): string {
  if (!value) return ''
  const deviceJid = value.match(/^(\d+):\d+@s\.whatsapp\.net$/)
  if (deviceJid) return `${deviceJid[1]}@s.whatsapp.net`
  if (value.includes('@')) return value
  const devicePhone = value.match(/^(\d+):\d+$/)
  if (devicePhone) return `${devicePhone[1]}@s.whatsapp.net`
  const digits = value.replace(/[^\d]/g, '')
  return digits ? `${digits}@s.whatsapp.net` : value
}

export function displayPhoneForJidLike(value: string): string {
  if (!value || value.endsWith('@lid')) return ''
  return value.replace(/@s\.whatsapp\.net$/, '').replace(/[^\d]/g, '')
}

export function looksLikeLidNumber(value?: string): boolean {
  const digits = String(value || '').replace(/[^\d]/g, '')
  return digits.length >= 14 && !digits.startsWith('972')
}

export function displayPhone(phoneNumber: string): string {
  if (!phoneNumber || isLidJid(phoneNumber) || phoneNumber.endsWith('@g.us')) return ''
  return phoneNumber.replace(/@s\.whatsapp\.net$/, '').replace(/[^\d]/g, '')
}

export function contactName(contact?: Partial<Contact>): string {
  return contact?.name || whatsappName(contact)
}

export function whatsappName(contact?: Partial<Contact>): string {
  return contact?.verifiedName || contact?.notify || contact?.username || ''
}

export function contactImage(contact?: Partial<Contact>): string {
  return contact?.imgUrl && contact.imgUrl !== 'changed' ? contact.imgUrl : ''
}

// -------- ContactCache class --------

export class ContactCache {
  private deps: ContactCacheDeps
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(deps: ContactCacheDeps) {
    this.deps = deps
  }

  // -------- Contact storage --------

  rememberContact(contact: Partial<Contact>, persist = true): void {
    const { redis, label, contactCacheKey, contacts, lidToPhone, chats } = this.deps
    if (contact.phoneNumber) contact.phoneNumber = normalizePhoneJid(contact.phoneNumber)
    if (isLidJid(contact.id) && contact.phoneNumber && !contact.lid) contact.lid = contact.id
    const ids = [contact.id, contact.phoneNumber, contact.lid].filter(Boolean) as string[]
    if (!contactName(contact)) {
      const namedExisting = ids
        .map(id => contacts.get(id))
        .find(existing => contactName(existing))
      if (namedExisting) {
        contact = {
          ...namedExisting,
          ...contact,
          name: namedExisting.name,
          verifiedName: namedExisting.verifiedName,
          notify: namedExisting.notify
        }
      }
    }
    for (const id of ids) contacts.set(id, contact)
    if (contact.lid && contact.phoneNumber) {
      lidToPhone.set(contact.lid, contact.phoneNumber)
      this.persistLidMapping(contact.lid, contact.phoneNumber)
      this.mergeChatJid(contact.lid, contact.phoneNumber)
    }
    if (persist && ids.length) {
      const persistIds = ids.filter(id => !isLidJid(id))
      if (contactName(contact)) {
        const tx = redis.multi()
        for (const id of persistIds) tx.hset(contactCacheKey, id, JSON.stringify(contact))
        for (const id of ids.filter(id => isLidJid(id))) tx.hdel(contactCacheKey, id)
        tx.exec().catch((err: any) => console.error(`${label}: failed saving contact`, err.message))
      } else {
        const lidIds = ids.filter(id => isLidJid(id))
        if (lidIds.length) {
          redis.multi()
            .hdel(contactCacheKey, ...lidIds)
            .exec()
            .catch((err: any) => console.error(`${label}: failed cleaning lid contact`, err.message))
        }
      }
    }
  }

  contactForJid(jid: string): Partial<Contact> | undefined {
    const { contacts, lidToPhone } = this.deps
    const mappedPhone = lidToPhone.get(jid)
    const direct = contacts.get(jid)
    const mapped = mappedPhone ? contacts.get(mappedPhone) : undefined
    const named = [direct, mapped].find(contact => contactName(contact))
    if (named) return named
    const found = direct || mapped
    // Reverse LID lookup
    if (!isLidJid(jid)) {
      for (const [lid, phone] of lidToPhone) {
        if (phone === jid) {
          const contact = contacts.get(lid)
          if (contact && contactName(contact)) return contact
        }
      }
    }
    // Fallback: try canonical JID
    const canonical = this.canonicalJid(jid)
    if (canonical !== jid) return contacts.get(canonical) || found
    return found
  }

  phoneForJid(jid: string, contact?: Partial<Contact>): string {
    const { lidToPhone } = this.deps
    return normalizePhoneJid(contact?.phoneNumber || lidToPhone.get(jid) || (jid.endsWith('@s.whatsapp.net') ? jid : ''))
  }

  canonicalJid(jid: string): string {
    const { lidToPhone } = this.deps
    if (isJidGroup(jid)) return jid
    return normalizePhoneJid(lidToPhone.get(jid) || jid)
  }

  // -------- Identity --------

  ownJidValues(): Set<string> {
    const sock = this.deps.getSock()
    const values = new Set<string>()
    const candidates = [
      this.deps.getOwnId(),
      sock?.user?.id,
      sock?.user?.lid,
      sock?.user?.jid
    ]
    for (const candidate of candidates) {
      const value = String(candidate || '')
      if (!value) continue
      values.add(value)
      values.add(this.canonicalJid(value))
      const user = value.split('@')[0]?.split(':')[0]
      if (user) values.add(normalizePhoneJid(`${user}@s.whatsapp.net`))
    }
    return values
  }

  isOwnJid(value?: string | null): boolean {
    if (!value) return false
    const values = this.ownJidValues()
    const raw = String(value)
    const phone = raw.split('@')[0]?.split(':')[0]
    return values.has(raw) || values.has(this.canonicalJid(raw)) || Boolean(phone && values.has(normalizePhoneJid(`${phone}@s.whatsapp.net`)))
  }

  isOwnReceipt(receipt: any): boolean {
    const candidates = [
      receipt?.userJid,
      receipt?.participant,
      receipt?.jid,
      receipt?.participantPn,
      receipt?.participantAlt
    ]
    return candidates.some(candidate => this.isOwnJid(candidate))
  }

  isOwnMessage(msg: any): boolean {
    return Boolean(
      msg.key.fromMe ||
      this.isOwnJid(msg.key.participant) ||
      this.isOwnJid((msg.key as any).participantPn) ||
      this.isOwnJid((msg.key as any).participantAlt)
    )
  }

  // -------- JID resolution --------

  messageRemoteJid(msg: any): string {
    const primary = msg.key.remoteJid
    const alt = (msg.key as any).remoteJidAlt
    if (isLidJid(primary) && alt) return normalizePhoneJid(alt)
    return primary ? this.canonicalJid(primary) : primary
  }

  keyRemoteJid(key: any): string {
    const primary = key?.remoteJid
    const alt = key?.remoteJidAlt
    if (isLidJid(primary) && alt) return normalizePhoneJid(alt)
    return primary ? this.canonicalJid(primary) : primary
  }

  async callRemoteJid(call: any): Promise<string | undefined> {
    if (call?.groupJid) return this.canonicalJid(call.groupJid)

    for (const value of [call?.callerPn, call?.from, call?.chatId]) {
      if (!value || this.isOwnJid(value)) continue
      let jid = this.canonicalJid(normalizePhoneJid(value))
      if (isLidJid(jid)) jid = await this.resolveLidToPhone(jid) || ''
      if (jid && !this.isOwnJid(jid) && !shouldIgnoreUiJid(jid)) return jid
    }
    return undefined
  }

  resolveOutgoingJid(jid: string): string {
    const resolved = this.canonicalJid(jid)
    if (isLidJid(resolved)) throw new Error('אין מספר טלפון עבור השיחה הזו')
    return resolved
  }

  // -------- Sender display --------

  senderNumberFromKey(key: any): string {
    const remoteJid = key?.remoteJid || ''
    const isGroup = isJidGroup(remoteJid)
    const candidates = [
      key?.participantAlt,
      key?.participantPn,
      key?.participant,
      ...(isGroup ? [] : [key?.remoteJidAlt, key?.remoteJid])
    ]
    for (const candidate of candidates) {
      const phone = this.phoneForJid(String(candidate || ''))
      const disp = displayPhone(phone)
      if (disp) return disp
    }
    return ''
  }

  participantPhone(msg: any): string {
    return this.senderNumberFromKey(msg.key)
  }

  senderDisplayName(key: any, fallback = ''): string {
    if (key?.fromMe) return 'אני'
    const remoteJid = key?.remoteJid || ''
    const isGroup = isJidGroup(remoteJid)
    const candidates = [
      key?.participantAlt,
      key?.participantPn,
      key?.participant,
      ...(isGroup ? [] : [key?.remoteJidAlt, key?.remoteJid])
    ].filter(Boolean) as string[]

    const canonicalCandidates = candidates.map(jid => this.canonicalJid(jid)).filter(Boolean) as string[]
    const allCandidates = [...new Set([...candidates, ...canonicalCandidates])]

    for (const jid of allCandidates) {
      const contact = this.contactForJid(jid)
      const name = contactName(contact)
      if (name) return name
    }

    if (fallback && !fallback.includes('@lid') && !fallback.endsWith('@g.us')) return fallback

    for (const jid of allCandidates) {
      const phone = displayPhone(this.phoneForJid(jid))
      if (phone) return phone
    }

    return ''
  }

  // -------- Chat enrichment --------

  enrichChat(chat: UiChat, fallbackName = ''): UiChat {
    const { contacts, lidToPhone } = this.deps
    const contact = this.contactForJid(chat.jid)
    const phoneNumber = this.phoneForJid(chat.jid, contact)
    const existingName = chat.name && !chat.name.includes('@') ? chat.name : ''
    const cleanFallback = fallbackName && !fallbackName.includes('@') ? fallbackName : ''
    chat.phoneNumber = phoneNumber
    chat.displayJid = phoneNumber ? displayPhone(phoneNumber) : chat.jid
    if (chat.isGroup) {
      chat.name = existingName || chat.displayJid
    } else {
      chat.name = contactName(contact) || cleanFallback || existingName || chat.displayJid
    }
    return chat
  }

  // -------- Chat/LID merge --------

  mergeChatJid(fromJid: string, toJid: string): void {
    const { chats, onChatEvent, onChatMerge, persistChat } = this.deps
    if (!fromJid || !toJid || fromJid === toJid) return
    const fromChat = chats.get(fromJid)
    const toChat = chats.get(toJid)

    if (fromChat) {
      const merged: UiChat = this.enrichChat({
        ...(fromChat || toChat),
        ...(toChat || {}),
        jid: toJid,
        timestamp: Math.max(fromChat.timestamp || 0, toChat?.timestamp || 0),
        unread: Math.max(fromChat.unread || 0, toChat?.unread || 0),
        lastMessage: (toChat?.timestamp || 0) >= (fromChat.timestamp || 0)
          ? (toChat?.lastMessage || fromChat.lastMessage)
          : fromChat.lastMessage
      } as UiChat)
      chats.delete(fromJid)
      chats.set(toJid, merged)
      persistChat(merged)
      onChatMerge(fromJid, toJid, merged)
    }
  }

  // -------- Group participants --------

  async rememberGroupParticipants(jid: string): Promise<void> {
    const { redis, groupMetadataCacheKey, groupMetadataCacheMs } = this.deps
    const sock = this.deps.getSock()
    if (!sock || !isJidGroup(jid)) return
    const cacheMs = Math.max(1000, groupMetadataCacheMs)
    const cacheKey = groupMetadataCacheKey(jid)
    const acquired = await redis.set(cacheKey, String(Date.now()), 'PX', cacheMs, 'NX')
    if (!acquired) return
    try {
      const group = await sock.groupMetadata(jid)
      const chat = this.deps.chats.get(jid)
      if (chat) {
        chat.name = group.subject || chat.name
        chat.participantCount = group.participants?.length || chat.participantCount || 0
        this.deps.persistChat(chat)
      }
      for (const participant of group.participants || []) this.rememberContact(participant)
    } catch {
      await redis.del(cacheKey).catch(() => {})
    }
  }

  // -------- Presence/typing --------

  private clearTypingTimer(jid: string): void {
    const timer = this.typingTimers.get(jid)
    if (timer) clearTimeout(timer)
    this.typingTimers.delete(jid)
  }

  private scheduleTypingExpiry(chat: UiChat): void {
    this.clearTypingTimer(chat.jid)
    const typingTimestamp = chat.typingTimestamp
    const timer = setTimeout(() => {
      this.typingTimers.delete(chat.jid)
      if (!chat.typing || chat.typingTimestamp !== typingTimestamp) return
      chat.typing = null
      chat.typingTimestamp = undefined
      this.deps.persistChat(chat)
      this.deps.onChatEvent(chat)
    }, TYPING_EXPIRY_MS)
    timer.unref?.()
    this.typingTimers.set(chat.jid, timer)
  }

  processPresenceData(chat: UiChat, presences: Record<string, { lastKnownPresence?: string; lastSeen?: number }>): void {
    const { onChatEvent, persistChat } = this.deps
    for (const [participant, data] of Object.entries(presences)) {
      if (this.isOwnJid(participant)) continue
      if (data.lastSeen) {
        chat.lastSeen = Number(data.lastSeen) * 1000
      }
      const presence = data.lastKnownPresence
      if (presence === 'composing' || presence === 'recording') {
        if (chat.isGroup) {
          const isGroupJid = isJidGroup(participant)
          const isSameAsChat = participant === chat.jid
          let senderName = ''
          if (isGroupJid || isSameAsChat) {
            senderName = participant.replace(/@.*$/, '') || ' '
          } else {
            const contact = this.contactForJid(participant)
            const name = contactName(contact)
            if (name && name !== chat.name && name !== chat.displayJid) {
              senderName = name
            } else {
              senderName = participant.replace(/@.*$/, '') || ' '
            }
          }
          chat.typing = senderName
        } else {
          chat.typing = 'typing'
        }
        chat.typingTimestamp = Date.now()
        this.scheduleTypingExpiry(chat)
      } else if (presence === 'available' || presence === 'unavailable') {
        this.clearTypingTimer(chat.jid)
        chat.typing = null
        chat.typingTimestamp = undefined
      }
      persistChat(chat)
      onChatEvent(chat)
      break
    }
  }

  // -------- LID resolution --------

  findChatByLid(id: string): string | undefined {
    const { lidToPhone } = this.deps
    const mapped = lidToPhone.get(id)
    if (mapped) return mapped
    const canonical = this.canonicalJid(id)
    if (canonical !== id) return canonical
    return undefined
  }

  async resolveLidToPhone(id: string): Promise<string | undefined> {
    const { lidToPhone } = this.deps
    const sock = this.deps.getSock()
    if (!sock?.signalRepository?.lidMapping) return undefined
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(id)
      if (!pn) return undefined
      const phoneJid = normalizePhoneJid(pn)
      lidToPhone.set(id, phoneJid)
      this.persistLidMapping(id, phoneJid)
      this.mergeChatJid(id, phoneJid)
      return phoneJid
    } catch {
      return undefined
    }
  }

  persistLidMapping(lid: string, phoneJid: string): void {
    if (!lid || !phoneJid) return
    this.deps.redis.hset(this.deps.lidCacheKey, lid, phoneJid).catch((err: any) => {
      console.error(`${this.deps.label}: failed saving lid mapping`, err.message)
    })
  }

  // -------- Cache restore --------

  async restoreUiCache(): Promise<void> {
    const { redis, contactCacheKey, lidCacheKey, label, chats, lidToPhone, chatIndexKey, removeChatStore, restoreMessages, persistChat } = this.deps
    try {
      // Restore LID → phone mappings
      const rawLids = await redis.hgetall(lidCacheKey)
      if (rawLids) {
        for (const [lid, phoneJid] of Object.entries(rawLids)) {
          if (phoneJid) lidToPhone.set(lid, phoneJid)
        }
      }

      const rawContacts = await redis.hgetall(contactCacheKey)
      const lidContactIds = Object.keys(rawContacts || {}).filter(isLidJid)
      if (lidContactIds.length) await redis.hdel(contactCacheKey, ...lidContactIds)
      for (const raw of Object.values(rawContacts || {})) {
        if (!raw) continue
        const parsed = JSON.parse(raw)
        if (!contactName(parsed)) continue
        this.rememberContact(parsed, false)
      }
      await this.cleanupLidUiCache()

      const CHAT_LIMIT = 500
      const chatCacheKey = this.deps.chatCacheKey
      const chatIds = await redis.zrevrange(chatIndexKey, 0, CHAT_LIMIT - 1)
      const rawChats = chatIds.length
        ? await redis.hmget(chatCacheKey, ...chatIds)
        : Object.values(await redis.hgetall(chatCacheKey))

      for (const raw of rawChats || []) {
        if (!raw) continue
        const chat: UiChat = JSON.parse(raw)
        const hadPersistedTyping = 'typing' in chat || 'typingTimestamp' in chat
        delete chat.typing
        delete chat.typingTimestamp
        if (isLidJid(chat.jid)) {
          const phone = lidToPhone.get(chat.jid)
          if (phone) this.mergeChatJid(chat.jid, phone)
          else await removeChatStore(chat.jid)
          continue
        }
        chat.avatarUrl = ''
        const storedJid = chat.jid
        const canonicalJid = this.canonicalJid(storedJid)
        if (canonicalJid !== storedJid) {
          chats.set(storedJid, chat)
          this.mergeChatJid(storedJid, canonicalJid)
          continue
        }
        if (chat.phoneNumber) chat.displayJid = displayPhone(chat.phoneNumber)
        else chat.displayJid ||= chat.jid
        chat.phoneNumber ||= chat.displayJid !== chat.jid ? chat.displayJid : ''
        this.enrichChat(chat)
        if (chat?.jid && (chat.timestamp || chat.lastMessage)) {
          chats.set(chat.jid, chat)
          if (hadPersistedTyping) persistChat(chat)
        }
      }

      await restoreMessages()
    } catch (err: any) {
      console.error(`${label}: failed restoring UI cache`, err.message)
    }
  }

  async cleanupLidUiCache(): Promise<void> {
    const { redis, lidToPhone, chatIndexKey, removeMessageStore } = this.deps
    const chatCacheKey = this.deps.chatCacheKey
    const [indexedIds, cachedIds] = await Promise.all([redis.zrange(chatIndexKey, 0, -1), redis.hkeys(chatCacheKey)])
    const chatIds = [...new Set([...indexedIds, ...cachedIds])]
    const tx = redis.multi()
    for (const jid of chatIds.filter(isLidJid)) {
      const phone = lidToPhone.get(jid)
      if (phone) {
        this.mergeChatJid(jid, phone)
      } else {
        tx.hdel(chatCacheKey, jid)
        tx.zrem(chatIndexKey, jid)
        await removeMessageStore(jid)
      }
    }
    await tx.exec()
  }

  upsertContact(contact: Partial<Contact>): void {
    const { chats, persistChat, trimChatCache, onChatEvent, removeNonChat, sock } = this.deps
    const jid = contact.phoneNumber || (isLidJid(contact.id) ? undefined : contact.id) || contact.lid
    if (shouldIgnoreUiJid(jid)) return
    this.rememberContact(contact)
    const existing = chats.get(jid) || (contact.lid ? chats.get(contact.lid) : undefined) || (contact.phoneNumber ? chats.get(contact.phoneNumber) : undefined)
    if (!existing) {
      removeNonChat(jid)
      return
    }
    this.enrichChat(existing)
    chats.set(existing.jid, existing)
    persistChat(existing)
    trimChatCache()
    onChatEvent(existing)
  }

  async ensureChatMeta(jid: string, fallbackName: string): Promise<UiChat | undefined> {
    const { chats, persistChat, trimChatCache } = this.deps
    const sock = this.deps.getSock()
    jid = this.canonicalJid(jid)
    if (shouldIgnoreUiJid(jid)) return
    const existing = chats.get(jid)
    const contact = this.contactForJid(jid)
    const chat: UiChat = existing || {
      jid,
      displayJid: jid,
      phoneNumber: '',
      name: contactName(contact) || fallbackName || jid,
      lastMessage: '',
      timestamp: 0,
      unread: 0,
      isGroup: isJidGroup(jid),
      isMuted: false,
      isArchived: false
    }

    if (chat.isGroup) this.rememberGroupParticipants(jid).catch(() => {})
    this.enrichChat(chat, chat.isGroup ? '' : fallbackName)

    chats.set(jid, chat)
    persistChat(chat)
    trimChatCache()
    if (!chat.isGroup && sock) {
      console.log(`${this.deps.label}: subscribing to presence for`, jid)
      sock.presenceSubscribe(jid).catch(err => console.error(`${this.deps.label}: subscribe error`, err.message))
    }
    return chat
  }
}
