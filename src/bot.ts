import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getUrlInfo,
  initAuthCreds,
  isJidGroup,
  makeWASocket,
  proto
} from '@whiskeysockets/baileys'
import sharp from 'sharp'
import type { WAMessage } from '@whiskeysockets/baileys'
import type { WAMessageKey, WAUrlInfo } from '@whiskeysockets/baileys/lib/Types/Message.js'
import type { Chat } from '@whiskeysockets/baileys/lib/Types/Chat.js'
import type { Contact } from '@whiskeysockets/baileys/lib/Types/Contact.js'
import { deleteHSetKeys, useRedisAuthStateWithHSet } from 'baileys-redis-auth'
import { EventEmitter } from 'events'
import qrcode from 'qrcode-terminal'
import type { UiChat, UiMessage, LinkPreviewData, ContactData, MessagePatch, BotStatus, GroupMention } from './types.ts'
import {
  ContactCache,
  isLidJid,
  shouldIgnoreUiJid,
  shouldIgnoreChatJid,
  normalizePhoneJid,
  displayPhoneForJidLike,
  looksLikeLidNumber,
  displayPhone,
  contactName,
  whatsappName,
  contactImage
} from './contact-cache.ts'
import { ChatStore } from './chat-store.ts'
import {
  normalizeTimestamp,
  getMessageContent,
  unwrapMessageForMedia,
  isViewOnceBaileysMessage,
  viewOnceKindFromType,
  viewOnceLabel,
  messageText,
  messageType,
  messageMedia,
  messageContact,
  messageLinkPreview,
  messageContext,
  isForwardedMessage,
  callInfoFromMessage,
  messagePatchFromContent,
  isTransportMessage,
  isSupportedMessageType,
  messageInteractiveData,
  phoneFromVcard
} from './message-processor.ts'
import { MessageStore } from './message-store.ts'
import { mergeMessagePatch } from './message-utils.ts'

const redisOptions = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASS || undefined,
  db: 6
}
const sharedWhatsAppNames = new Map<string, string>()

const CACHE_LIMIT = 100
const MEMORY_MESSAGE_LIMIT = 300
const STORED_MESSAGE_LIMIT = Number(process.env.UI_STORED_MESSAGE_LIMIT || 0)
const MEDIA_CACHE_TTL_SECONDS = Number(process.env.UI_MEDIA_CACHE_TTL_SECONDS || 14 * 24 * 60 * 60)
const CHAT_LIMIT = 500
const syncFullHistory = process.env.SYNC_FULL_HISTORY !== 'false'
const WA_QUERY_TIMEOUT_MS = Number(process.env.WA_QUERY_TIMEOUT_MS || 180000)
const CHAT_SETTINGS_RESYNC_INTERVAL_MS = Number(process.env.UI_CHAT_SETTINGS_RESYNC_INTERVAL_MS || 24 * 60 * 60 * 1000)
const HISTORY_SYNC_WAIT_MS = Number(process.env.UI_HISTORY_SYNC_WAIT_MS || 120000)
const HISTORY_SYNC_INITIAL_WAIT_MS = Number(process.env.UI_HISTORY_SYNC_INITIAL_WAIT_MS || 10000)
const GROUP_METADATA_CACHE_MS = Number(process.env.UI_GROUP_METADATA_CACHE_MS || 10 * 60 * 1000)
const LINK_PREVIEW_TIMEOUT_MS = Number(process.env.UI_LINK_PREVIEW_TIMEOUT_MS || 5000)
const LINK_PREVIEW_CACHE_MS = Number(process.env.UI_LINK_PREVIEW_CACHE_MS || 2 * 60 * 1000)

export function linkPreviewUrlFromText(text: string): { matchedText: string, fetchUrl: string } | undefined {
  const matchedText = text.match(/(?:https?:\/\/|www\.)[^\s<>"']+/i)?.[0]
  if (!matchedText) return undefined
  return {
    matchedText,
    fetchUrl: matchedText.toLowerCase().startsWith('www.') ? `https://${matchedText}` : matchedText
  }
}

function publicLinkPreview(preview: Awaited<ReturnType<typeof getUrlInfo>>): LinkPreviewData | undefined {
  if (!preview) return undefined
  return {
    url: preview['canonical-url'] || preview['matched-text'],
    matchedText: preview['matched-text'],
    title: preview.title,
    description: preview.description,
    thumbnail: preview.jpegThumbnail ? `data:image/jpeg;base64,${Buffer.from(preview.jpegThumbnail).toString('base64')}` : undefined,
    thumbnailWidth: Number(preview.highQualityThumbnail?.width || 0) || undefined,
    thumbnailHeight: Number(preview.highQualityThumbnail?.height || 0) || undefined
  }
}

async function transcribeBuffer(buffer: Buffer): Promise<string> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), parseInt(process.env.TRANSCRIBE_TIMEOUT_MS, 10) || 300000)
    try {
      const res = await fetch(
        'http://' + process.env.REDIS_HOST + ':8000/transcribe',
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'blob', data: buffer.toString('base64'), model: 'ivrit-ai/whisper-large-v3-turbo-ct2' })
        }
      )
      if (!res.ok) {
        console.error('transcription error status:', res.status)
        return ''
      }
      const data = await res.json()
      return data.text || ''
    } finally {
      clearTimeout(timeout)
    }
  } catch (err: any) {
    console.error('transcription error:', err.message)
    return ''
  }
}

async function deleteRedisPattern(redis: any, pattern: string): Promise<void> {
  let cursor = '0'
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = String(nextCursor)
    if (keys.length) await redis.unlink(...keys)
  } while (cursor !== '0')
}

export class Bot {
  // -------- Public properties --------
  sock: ReturnType<typeof makeWASocket> | undefined = undefined
  events: EventEmitter
  id = ''
  botId = '' // map key in the bots Map (e.g. 'bot1', 'bot2')
  readonly authKey: string
  readonly label: string
  connection = 'connecting'
  qr = ''
  chats: Map<string, UiChat>
  messages: Map<string, UiMessage[]>
  contacts: Map<string, Partial<Contact>>
  lidToPhone: Map<string, string>

  // -------- Stores --------
  contactCache!: ContactCache
  messageStore!: MessageStore
  chatStore!: ChatStore

  // -------- Internal state --------
  redis: any
  state: any
  saveCreds: any
  healedGroups: Map<string, number>
  pendingChatSettings: Map<string, Partial<Chat>>
  chatCacheKey: string
  chatIndexKey: string
  contactCacheKey: string
  lidCacheKey: string
  messageIndexKey: (jid: string) => string
  messagePayloadKey: (jid: string, id: string) => string
  mediaCacheKey: (jid: string, id: string) => string
  groupMetadataCacheKey: (jid: string) => string
  chatSettingsSyncKey: string
  currentWait: NodeJS.Timeout | undefined
  transcriptionCache: Map<string, string>
  linkPreviewCache: Map<string, { expiresAt: number, promise: Promise<WAUrlInfo | undefined> }>
  callPeers: Map<string, string>
  chatStoreSocket: { current: any }
  avatarLoads: Map<string, Promise<void>>
  avatarFailures: Map<string, number>
  avatarQueue: Array<() => void>
  avatarActive = 0

  constructor(authKey: string, label: string, state: any, saveCreds: any, redis: any, botId = '') {
    this.events = new EventEmitter()
    this.authKey = authKey
    this.label = label
    this.botId = botId
    this.state = state
    this.saveCreds = saveCreds
    this.redis = redis
    this.chats = new Map<string, UiChat>()
    this.messages = new Map<string, UiMessage[]>()
    this.contacts = new Map<string, Partial<Contact>>()
    this.lidToPhone = new Map<string, string>()
    this.healedGroups = new Map<string, number>()
    this.pendingChatSettings = new Map<string, Partial<Chat>>()
    this.transcriptionCache = new Map<string, string>()
    this.linkPreviewCache = new Map<string, { expiresAt: number, promise: Promise<WAUrlInfo | undefined> }>()
    this.callPeers = new Map<string, string>()
    this.avatarLoads = new Map<string, Promise<void>>()
    this.avatarFailures = new Map<string, number>()
    this.avatarQueue = []

    this.chatCacheKey = `ui:${authKey}:chats`
    this.chatIndexKey = `ui:${authKey}:chat-index`
    this.contactCacheKey = `ui:${authKey}:contacts`
    this.lidCacheKey = `ui:${authKey}:lid-phone`
    this.messageIndexKey = (jid: string) => `ui:${authKey}:message-index:${jid}`
    this.messagePayloadKey = (jid: string, id: string) => `ui:${authKey}:message:${Buffer.from(`${jid}:${id}`).toString('base64url')}`
    this.mediaCacheKey = (jid: string, id: string) => `ui:${authKey}:media:${Buffer.from(`${jid}:${id}`).toString('base64url')}`
    this.groupMetadataCacheKey = (jid: string) => `ui:${authKey}:group-metadata-fetched:${jid}`
    this.chatSettingsSyncKey = `ui:${authKey}:chat-settings-sync-at:archive-v1`

    this.chatStoreSocket = { current: null }

    // Initialize stores
    this.contactCache = new ContactCache({
      redis,
      label,
      contactCacheKey: this.contactCacheKey,
      lidCacheKey: this.lidCacheKey,
      chatCacheKey: this.chatCacheKey,
      chatIndexKey: this.chatIndexKey,
      groupMetadataCacheKey: (jid: string) => this.groupMetadataCacheKey(jid),
      groupMetadataCacheMs: GROUP_METADATA_CACHE_MS,
      getSock: () => this.sock,
      getOwnId: () => this.id,
      contacts: this.contacts,
      lidToPhone: this.lidToPhone,
      chats: this.chats,
      onChatEvent: (chat: UiChat) => this.events.emit('event', { type: 'chat', bot: authKey, chat }),
      onChatMerge: (fromJid: string, toJid: string, chat: UiChat) => {
        redis.multi().hdel(this.chatCacheKey, fromJid).zrem(this.chatIndexKey, fromJid).exec().catch(() => {})
        this.messageStore.mergeMessageStore(fromJid, toJid)
          .catch((err: any) => console.error(`${label}: failed merging message store`, { fromJid, toJid, error: err.message }))
        this.events.emit('event', { type: 'chat-merge', bot: authKey, fromJid, toJid, chat })
      },
      loadAvatar: (jid: string) => this.loadAvatar(jid),
      persistChat: (chat: UiChat) => this.persistChat(chat),
      trimChatCache: () => this.trimChatCache(),
      removeChatStore: (jid: string) => this.removeChatStore(jid),
      removeMessageStore: (jid: string) => this.messageStore.removeMessageStore(jid),
      removeNonChat: (jid: string) => this.removeNonChat(jid),
      restoreMessages: () => this.messageStore.restoreRecentMessages()
    })

    this.messageStore = new MessageStore({
      redis,
      label,
      messageIndexKey: this.messageIndexKey,
      messagePayloadKey: this.messagePayloadKey,
      mediaCacheKey: this.mediaCacheKey,
      MEDIA_CACHE_TTL_SECONDS,
      STORED_MESSAGE_LIMIT,
      MEMORY_MESSAGE_LIMIT,
      HISTORY_SYNC_WAIT_MS,
      canonicalJid: (jid: string) => this.contactCache.canonicalJid(jid),
      messages: this.messages,
      chats: this.chats,
      listChats: () => this.listChats(),
      getSock: () => this.sock,
      publicMessage: (message: UiMessage) => this.publicMessage(message),
      onMessageEvent: (jid: string, id: string, patch: MessagePatch) => {}
    })

    this.chatStore = new ChatStore({
      redis,
      label,
      chatCacheKey: this.chatCacheKey,
      chatIndexKey: this.chatIndexKey,
      messagePayloadKey: this.messagePayloadKey,
      chatSettingsSyncKey: this.chatSettingsSyncKey,
      CHAT_LIMIT,
      CHAT_SETTINGS_RESYNC_INTERVAL_MS,
      canonicalJid: (jid: string) => this.contactCache.canonicalJid(jid),
      isOwnReceipt: (receipt: any) => this.contactCache.isOwnReceipt(receipt),
      chats: this.chats,
      listChats: () => this.listChats(),
      sock: this.chatStoreSocket,
      onChatEvent: (chat: UiChat) => this.events.emit('event', { type: 'chat', bot: authKey, chat })
    })
  }

  // -------- Public API --------

  status(): BotStatus {
    const chats = this.listChats()
    return {
      id: this.id,
      authKey: this.authKey,
      label: this.label,
      connection: this.connection,
      qr: this.qr,
      chatCount: chats.length,
      unreadSessionCount: chats.filter(chat => Number(chat.unread || 0) > 0).length
    }
  }

  listChats(): UiChat[] {
    return [...this.chats.values()]
      .filter(chat => Boolean(chat.timestamp || chat.lastMessage))
      .filter(chat => !chat.jid.endsWith('@newsletter') && chat.jid !== 'status@broadcast')
      .sort((a, b) => b.timestamp - a.timestamp)
  }

  listContacts(): Array<{ jid: string; name: string; phoneNumber: string; vcard?: string }> {
    const seen = new Set<string>()
    const result: Array<{ jid: string; name: string; phoneNumber: string; vcard?: string }> = []
    const remember = (jid: string, name: string, phoneNumber = '') => {
      if (!jid || !name) return
      const canonicalJid = phoneNumber || this.lidToPhone.get(jid) || (!isLidJid(jid) ? normalizePhoneJid(jid) : jid)
      const keys = [jid, canonicalJid, phoneNumber].filter(Boolean)
      if (keys.some(key => seen.has(key))) return
      keys.forEach(key => seen.add(key))
      // Generate a vCard for sending
      let vcard = ''
      if (phoneNumber && name) {
        const cleanPhone = phoneNumber.replace(/[^\d]/g, '')
        vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;TYPE=CELL:+${cleanPhone}\nEND:VCARD`
      }
      result.push({ jid: canonicalJid, name, phoneNumber, vcard })
    }
    for (const [jid, contact] of this.contacts) {
      const name = contactName(contact)
      const phoneNumber = this.contactCache.phoneForJid(jid, contact)
      remember(jid, name, phoneNumber)
    }
    // Also add contacts from lidToPhone that have a chat but no contact entry
    for (const [lid, phone] of this.lidToPhone) {
      const chat = this.chats.get(phone)
      if (chat?.name) remember(lid, chat.name, phone)
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async getMessages(jid: string, limit = MEMORY_MESSAGE_LIMIT, before?: number): Promise<UiMessage[]> {
    jid = this.contactCache.canonicalJid(jid)
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const ids = before
      ? await this.redis.zrevrangebyscore(this.messageIndexKey(jid), `(${before}`, '-inf', 'LIMIT', 0, safeLimit)
      : await this.redis.zrange(this.messageIndexKey(jid), -safeLimit, -1)
    const raw = await this.messageStore.loadMessagePayloads(jid, ids)
    return raw
      .filter(Boolean)
      .map(item => this.publicMessage(JSON.parse(item!)))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  async syncOlderMessages(jid: string, count = 50) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.resolveOutgoingJid(jid)
    const oldest = await this.messageStore.getOldestStoredMessage(jid)
    if (!oldest) {
      const requestId = await this.messageStore.requestFullHistorySync()
      const messages = await this.messageStore.waitForStoredMessages(
        jid,
        Math.min(HISTORY_SYNC_INITIAL_WAIT_MS, HISTORY_SYNC_WAIT_MS, WA_QUERY_TIMEOUT_MS)
      )
      return { requestId, requested: 'full-history', received: messages.length, messages }
    }

    // The UI/store JID may be canonicalized from LID to PN. WhatsApp history
    // queries must use the original transport key or the phone returns an empty chunk.
    const transportKey = oldest.raw?.key || oldest.key || {}
    const key = {
      ...transportKey,
      id: transportKey.id || oldest.id,
      fromMe: transportKey.fromMe ?? oldest.fromMe,
      remoteJid: transportKey.remoteJid || jid
    }
    if (!key.id || !key.remoteJid) {
      const err: any = new Error('להודעה הישנה ביותר אין מזהה תקין להורדת היסטוריה מהטלפון')
      err.statusCode = 409
      throw err
    }
    const timestamp = normalizeTimestamp(oldest.raw?.messageTimestamp || oldest.timestamp || Date.now())
    const requestCount = Math.max(1, Math.min(count, 50))
    console.log(`${this.label}: requesting older messages`, {
      chatJid: key.remoteJid,
      uiJid: jid,
      anchorId: key.id,
      anchorTimestamp: timestamp,
      count: requestCount
    })
    const requestId = await this.sock.fetchMessageHistory(requestCount, key, timestamp)
    const messages = await this.messageStore.waitForOlderMessages(
      jid,
      oldest.timestamp,
      Math.min(HISTORY_SYNC_INITIAL_WAIT_MS, HISTORY_SYNC_WAIT_MS, WA_QUERY_TIMEOUT_MS)
    )
    return {
      requestId,
      requested: requestCount,
      anchorId: key.id,
      anchorJid: key.remoteJid,
      anchorTimestamp: timestamp,
      received: messages.length,
      messages
    }
  }

  async syncChatSettings(forceSnapshot = false) {
    if (!this.sock) throw new Error('Socket not connected')
    if (forceSnapshot) await this.state.keys.set({ 'app-state-sync-version': { regular_high: null } })
    await this.sock.resyncAppState(['regular_high'], true)
    return { ok: true, forceSnapshot }
  }

  async purgeAccountData() {
    await Promise.all([
      deleteHSetKeys({ redis: this.redis, sessionId: this.authKey, logger: console.log }),
      deleteRedisPattern(this.redis, `ui:${this.authKey}:*`)
    ])
    this.chats.clear()
    this.messages.clear()
    this.contacts.clear()
    this.lidToPhone.clear()
    this.healedGroups.clear()
    this.pendingChatSettings.clear()
    this.transcriptionCache.clear()
    this.linkPreviewCache.clear()
    this.callPeers.clear()
    this.avatarLoads.clear()
    this.avatarFailures.clear()
    this.avatarQueue = []
    this.avatarActive = 0
    const freshCreds = initAuthCreds()
    for (const key of Object.keys(this.state.creds || {})) delete this.state.creds[key]
    Object.assign(this.state.creds, freshCreds)
    this.id = ''
    this.qr = ''
    this.events?.emit('event', { type: 'account-purged', bot: this.authKey })
  }

  async markRead(jid: string) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.canonicalJid(jid)
    if (shouldIgnoreUiJid(jid)) return { marked: 0 }
    const stored = await this.messageStore.getStoredMessages(jid, 200)
    const memory = this.messages.get(jid) || []
    const keys = [...stored, ...memory]
      .filter(message => !message.fromMe && message.key?.id)
      .map(message => ({ ...message.key, remoteJid: jid }))
    if (keys.length) await this.sock.readMessages(keys)
    this.setChatUnread(jid, 0)
    return { marked: keys.length, remote: true }
  }

  async markLocalRead(jid: string) {
    jid = this.contactCache.canonicalJid(jid)
    if (shouldIgnoreUiJid(jid)) return { marked: 0 }
    this.setChatUnread(jid, 0)
    return { marked: 0, remote: false }
  }

  async markAllRead() {
    if (!this.sock) throw new Error('Socket not connected')
    let total = 0
    for (const chat of this.listChats()) {
      if (chat.unread > 0) {
        try {
          await this.markRead(chat.jid)
          total++
        } catch {}
      }
    }
    return { marked: total }
  }

  async archiveChat(jid: string, archive: boolean) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.canonicalJid(jid)
    await this.sock.chatModify({ archive }, jid)
    // Update local chat state immediately
    const chat = this.chats.get(jid)
    if (chat) {
      chat.isArchived = archive
      this.persistChat(chat)
    }
    return { ok: true, archived: archive }
  }

  async muteChat(jid: string, muted: boolean) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.canonicalJid(jid)
    // Mute for 1 week (604800000 ms), or null to unmute
    const muteDuration = muted ? 7 * 24 * 60 * 60 * 1000 : null
    await this.sock.chatModify({ mute: muteDuration }, jid)
    // Update local chat state immediately
    const chat = this.chats.get(jid)
    if (chat) {
      chat.isMuted = muted
      this.persistChat(chat)
    }
    return { ok: true, muted }
  }

  async getMedia(jid: string, messageId: string) {
    return await this.messageStore.getMedia(jid, messageId)
  }

  async loadAvatar(jid: string): Promise<void> {
    jid = this.contactCache.canonicalJid(jid)
    if (!jid || !this.sock) return

    const cacheKey = `ui:${this.authKey}:avatar:${jid}`
    const cached = await this.redis.getBuffer(cacheKey)
    if (cached) return

    const existing = this.avatarLoads.get(jid)
    if (existing) return existing
    if ((this.avatarFailures.get(jid) || 0) > Date.now()) return

    const load = this.queueAvatarLoad(() => this.fetchAndCacheAvatar(jid, cacheKey))
      .finally(() => this.avatarLoads.delete(jid))
    this.avatarLoads.set(jid, load)
    return load
  }

  async fetchAndCacheAvatar(jid: string, cacheKey: string): Promise<void> {
    const contact = this.contactCache.contactForJid(jid)
    const imgUrl = contact?.imgUrl
    let sourceUrl = imgUrl && imgUrl !== 'changed' && imgUrl.startsWith('https://') ? imgUrl : ''
    let avatarNotFound = false
    if (sourceUrl) {
      const resized = await this.downloadAndResizeAvatar(sourceUrl)
      if (resized) {
        await this.redis.set(cacheKey, resized)
        this.avatarFailures.delete(jid)
        return
      }
      sourceUrl = ''
    }

    if (!sourceUrl) {
      try {
        // User profile-picture IQs time out when Baileys attaches its stored privacy token.
        // This does not affect the separate privacy-token path used for 1:1 messages.
        if (this.sock!.serverProps) this.sock.serverProps.profilePicPrivacyToken = false
        sourceUrl = await this.withTimeout(
          this.sock.profilePictureUrl(jid, 'image', 10000),
          10500
        ) || ''
      } catch (err: any) {
        if (this.isAvatarNotFoundError(err)) {
          avatarNotFound = true
        } else {
          console.error(`${this.label}: avatar lookup failed for ${jid}`, err.message)
        }
      }
    }

    if (avatarNotFound) {
      this.avatarFailures.set(jid, Date.now() + 24 * 60 * 60 * 1000)
      return
    }

    if (!sourceUrl) {
      this.avatarFailures.set(jid, Date.now() + 6 * 60 * 1000)
      return
    }

    const resized = await this.downloadAndResizeAvatar(sourceUrl)
    if (resized) {
      await this.redis.set(cacheKey, resized)
      this.avatarFailures.delete(jid)
    } else {
      this.avatarFailures.set(jid, Date.now() + 5 * 60 * 1000)
    }
  }

  queueAvatarLoad(task: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const run = () => {
        this.avatarActive += 1
        task()
          .then(resolve, reject)
          .finally(() => {
            this.avatarActive -= 1
            this.avatarQueue.shift()?.()
          })
      }
      if (this.avatarActive < 2) run()
      else this.avatarQueue.push(run)
    })
  }

  isAvatarNotFoundError(error: any): boolean {
    const text = String(error?.message || error || '').toLowerCase()
    const status = Number(error?.output?.statusCode || error?.statusCode || error?.status || 0)
    return status === 404 || text.includes('item-not-found') || text.includes('not found')
  }

  async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout')), ms)
    })
    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      clearTimeout(timer!)
    }
  }

  async downloadAndResizeAvatar(url: string): Promise<Buffer | undefined> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15000)
      let response: Response
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'image/webp,image/*,*/*'
          }
        })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) {
        console.error(`${this.label}: avatar download returned ${response.status} from ${url.slice(0, 80)}`)
        return undefined
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 50) {
        console.error(`${this.label}: avatar too small (${buffer.length} bytes) from ${url.slice(0, 80)}`)
        return undefined
      }
      return await sharp(buffer)
        .resize(100, 100, { fit: 'cover', position: 'centre' })
        .webp({ quality: 80 })
        .toBuffer()
    } catch (err: any) {
      console.error(`${this.label}: failed to download/resize avatar`, err.message, 'from', url.slice(0, 80))
      return undefined
    }
  }

  async groupParticipants(jid: string): Promise<GroupMention[]> {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.resolveOutgoingJid(jid)
    if (!isJidGroup(jid)) return []
    const group = await this.sock.groupMetadata(jid)
    const useLid = group.addressingMode === 'lid'
    const recentMessages = await this.messageStore.getStoredMessages(jid, 500).catch(() => this.messages.get(jid) || [])
    const allMemoryMessages = [...(this.messages?.values() || [])].flat()
    return Promise.all((group.participants || []).map(async participant => {
      this.contactCache.rememberContact(participant)
      const mentionJid = useLid
        ? participant.lid || (participant.id?.endsWith('@lid') ? participant.id : '')
        : participant.phoneNumber || participant.id
      let phoneNumber = this.contactCache.phoneForJid(mentionJid || participant.id, participant)
      if (!phoneNumber && mentionJid.endsWith('@lid')) {
        phoneNumber = await this.contactCache.resolveLidToPhone(mentionJid) || ''
      }
      const savedContact = this.contactCache.contactForJid(mentionJid || participant.id)
        || this.contactCache.contactForJid(phoneNumber)
      const directChat = this.chats?.get(phoneNumber)
        || [...(this.chats?.values() || [])].find(chat => !chat.isGroup && chat.phoneNumber === phoneNumber)
      const directChatName = directChat?.name
        && directChat.name !== directChat.jid
        && directChat.name !== directChat.displayJid
        && !/^\+?\d+$/.test(directChat.name)
        ? directChat.name
        : ''
      const identifiers = new Set([mentionJid, participant.id, participant.lid, participant.phoneNumber, phoneNumber].filter(Boolean))
      const historicalName = [...recentMessages].reverse().find(message => {
        const key = message.key as any
        const messageIdentifiers = [key?.participant, key?.participantAlt, key?.participantPn]
        if (messageIdentifiers.some(value => value && identifiers.has(value))) return true
        const participantPhone = displayPhone(phoneNumber)
        return Boolean(participantPhone && message.senderNumber === participantPhone)
      })?.raw?.pushName || [...recentMessages].reverse().find(message => {
        const key = message.key as any
        return [key?.participant, key?.participantAlt, key?.participantPn].some(value => value && identifiers.has(value))
      })?.sender
      const usableHistoricalName = historicalName && !/^\+?\d+$/.test(historicalName) ? historicalName : ''
      const participantPhone = displayPhone(phoneNumber)
      const globalMessage = [...allMemoryMessages].reverse().find(message => {
        const key = message.key as any
        if (participantPhone && message.senderNumber === participantPhone) return true
        return [key?.participant, key?.participantAlt, key?.participantPn].some(value => value && identifiers.has(value))
      })
      const globalName = globalMessage?.raw?.pushName || globalMessage?.sender || ''
      const usableGlobalName = globalName && !/^\+?\d+$/.test(globalName) ? globalName : ''
      const sharedName = sharedWhatsAppNames.get(phoneNumber) || sharedWhatsAppNames.get(mentionJid)
      const learnedWhatsAppName = whatsappName(savedContact)
        || whatsappName(participant)
        || usableHistoricalName
        || usableGlobalName
      if (learnedWhatsAppName) {
        for (const id of identifiers) sharedWhatsAppNames.set(id, learnedWhatsAppName)
      }
      const name = savedContact?.name
        || whatsappName(savedContact)
        || whatsappName(participant)
        || directChatName
        || usableHistoricalName
        || usableGlobalName
        || sharedName
        || 'Unknown participant'
      if (name !== 'Unknown participant' && !/^\+?\d+$/.test(name)) {
        for (const id of identifiers) sharedWhatsAppNames.set(id, name)
      }
      return { jid: mentionJid, name, phoneNumber }
    })).then(participants => participants.filter(participant => participant.jid))
  }

  async sendText(jid: string, text: string, quotedId = '', quotedJid = '', mentions: string[] = []) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.resolveOutgoingJid(jid)
    const quoted = quotedId ? await this.messageStore.getStoredMessage(quotedJid || jid, quotedId) : undefined
    const preview = await this.resolveLinkPreview(text)
    const allowedMentions = isJidGroup(jid) && mentions.length
      ? new Set((await this.groupParticipants(jid)).map(participant => participant.jid))
      : new Set<string>()
    const resolvedMentions = [...new Set(mentions.filter(mention => allowedMentions.has(mention)))]
    const sent = await this.sock.sendMessage(
      jid,
      { text, linkPreview: preview || null, mentions: resolvedMentions },
      quoted?.raw ? { quoted: quoted.raw } : undefined
    )
    const now = Date.now()
    const message = this.recordUiMessage({
      id: sent?.key?.id || `${now}`,
      jid,
      key: sent?.key || { remoteJid: jid, id: `${now}`, fromMe: true } as WAMessageKey,
      quoted: quoted ? this.quotedPreview(quoted) : undefined,
      linkPreview: publicLinkPreview(preview),
      fromMe: true,
      sender: 'אני',
      text,
      type: 'conversation',
      status: 'sent',
      timestamp: now
    })
    return message
  }

  async previewText(text: string) {
    return publicLinkPreview(await this.resolveLinkPreview(text))
  }

  async resolveLinkPreview(text: string): Promise<WAUrlInfo | undefined> {
    const trimmedText = text.trim()
    if (!trimmedText) return undefined
    const link = linkPreviewUrlFromText(trimmedText)
    if (!link) return undefined
    const key = link.fetchUrl
    const cached = this.linkPreviewCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.promise

    const promise = getUrlInfo(link.fetchUrl, {
        thumbnailWidth: 192,
        fetchOpts: { timeout: LINK_PREVIEW_TIMEOUT_MS }
      })
      .then(preview => preview ? { ...preview, 'matched-text': link.matchedText } : undefined)
      .catch((err: any) => {
      console.error(`${this.label}: link preview failed`, err.message)
      return undefined
    })
    this.linkPreviewCache.set(key, { expiresAt: Date.now() + LINK_PREVIEW_CACHE_MS, promise })
    if (this.linkPreviewCache.size > CACHE_LIMIT) {
      const oldestKey = this.linkPreviewCache.keys().next().value
      if (oldestKey) this.linkPreviewCache.delete(oldestKey)
    }
    return promise
  }

  async deleteMessage(jid: string, messageId: string) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.canonicalJid(jid)
    const message = await this.messageStore.getStoredMessage(jid, messageId)
    if (!message?.key?.id) throw new Error('הודעה לא נמצאה')
    await this.sock.sendMessage(jid, { delete: { ...message.key, remoteJid: jid } })
    const patch: MessagePatch = { deleted: true, deletedAt: Date.now(), deletedBy: this.id || 'me' }
    this.updateStoredMessage(jid, messageId, patch)
    return { id: messageId, patch }
  }

  async reactMessage(jid: string, messageId: string, emoji: string) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.canonicalJid(jid)
    const message = await this.messageStore.getStoredMessage(jid, messageId)
    if (!message?.key?.id) throw new Error('הודעה לא נמצאה')
    await this.sock.sendMessage(jid, { react: { text: emoji, key: { ...message.key, remoteJid: jid } } })
    const patch: MessagePatch = {
      reaction: {
        userJid: 'me',
        sender: 'אני',
        text: emoji,
        timestamp: Date.now()
      }
    }
    this.updateStoredMessage(jid, messageId, patch)
    return { id: messageId, patch }
  }

  async forwardMessage(sourceJid: string, sourceId: string, targetJid: string) {
    if (!this.sock) throw new Error('Socket not connected')
    sourceJid = this.contactCache.canonicalJid(sourceJid)
    targetJid = this.contactCache.resolveOutgoingJid(targetJid)

    const message = await this.messageStore.getStoredMessage(sourceJid, sourceId)
    if (!message) throw new Error('הודעה לא נמצאה')

    if (message.media) {
      // Forward media message
      const media = await this.messageStore.getMedia(sourceJid, sourceId)
      const content: any =
        media.mimetype.startsWith('image/')
          ? { image: media.buffer, mimetype: media.mimetype, caption: message.text || '' }
          : media.mimetype.startsWith('video/')
            ? { video: media.buffer, mimetype: media.mimetype, caption: message.text || '' }
            : media.mimetype.startsWith('audio/')
              ? { audio: media.buffer, mimetype: media.mimetype }
              : { document: media.buffer, fileName: media.fileName || 'file', mimetype: media.mimetype, caption: message.text || '' }
      content.contextInfo = { forwardingScore: 1, isForwarded: true }

      const sent = await this.sock.sendMessage(targetJid, content)
      const now = Date.now()
      if (sent?.key?.id) {
        await this.messageStore.persistMedia(targetJid, sent.key.id, media.buffer)
      }
      const resultMedia = media.mimetype.startsWith('image/')
        ? { kind: 'image' as const, mimetype: media.mimetype, caption: message.text || '', url: '' }
        : media.mimetype.startsWith('video/')
          ? { kind: 'video' as const, mimetype: media.mimetype, caption: message.text || '', url: '' }
          : media.mimetype.startsWith('audio/')
            ? { kind: 'audio' as const, mimetype: media.mimetype, caption: '', fileName: media.fileName, url: '' }
            : { kind: 'document' as const, mimetype: media.mimetype, caption: message.text || '', fileName: media.fileName, url: '' }
      const result = this.recordUiMessage({
        id: sent?.key?.id || `${now}`,
        jid: targetJid,
        key: sent?.key || { remoteJid: targetJid, id: `${now}`, fromMe: true } as WAMessageKey,
        media: resultMedia,
        forwarded: true,
        fromMe: true,
        sender: 'אני',
        text: message.text || '',
        type: media.mimetype.startsWith('image/') ? 'imageMessage' : media.mimetype.startsWith('video/') ? 'videoMessage' : media.mimetype.startsWith('audio/') ? 'audioMessage' : 'documentMessage',
        status: 'sent',
        timestamp: now
      })
      return result
    }

    // Forward text message (or contact/link preview)
    const text = message.text || ''
    const preview = await this.resolveLinkPreview(text)
    const sent = await this.sock.sendMessage(
      targetJid,
      {
        text,
        linkPreview: preview || null,
        contextInfo: { forwardingScore: 1, isForwarded: true }
      },
      undefined
    )
    const now = Date.now()
    const result = this.recordUiMessage({
      id: sent?.key?.id || `${now}`,
      jid: targetJid,
      key: sent?.key || { remoteJid: targetJid, id: `${now}`, fromMe: true } as WAMessageKey,
      quoted: message.quoted ? this.quotedPreview(message) : undefined,
      linkPreview: publicLinkPreview(preview),
      forwarded: true,
      fromMe: true,
      sender: 'אני',
      text,
      type: 'conversation',
      status: 'sent',
      timestamp: now
    })
    return result
  }

  async sendContact(jid: string, displayName: string, vcard: string) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.resolveOutgoingJid(jid)
    const sent = await this.sock.sendMessage(jid, {
      contacts: {
        displayName,
        contacts: [{ vcard }]
      }
    })
    const now = Date.now()
    const resultContact = {
      displayName,
      phone: phoneFromVcard(vcard)
    }
    const message = this.recordUiMessage({
      id: sent?.key?.id || `${now}`,
      jid,
      key: sent?.key || { remoteJid: jid, id: `${now}`, fromMe: true } as WAMessageKey,
      contact: resultContact,
      fromMe: true,
      sender: 'אני',
      text: displayName,
      type: 'contactMessage',
      status: 'sent',
      timestamp: now
    })
    return message
  }

  async sendFile(jid: string, file: Buffer, fileName: string, mimeType: string, caption = '', forwarded = false) {
    if (!this.sock) throw new Error('Socket not connected')
    jid = this.contactCache.resolveOutgoingJid(jid)
    const content: any =
      mimeType.startsWith('image/')
        ? { image: file, mimetype: mimeType, caption }
        : mimeType.startsWith('video/')
          ? { video: file, mimetype: mimeType, caption }
          : mimeType.startsWith('audio/')
            ? { audio: file, mimetype: mimeType }
            : { document: file, fileName, mimetype: mimeType, caption }
    if (forwarded) content.contextInfo = { forwardingScore: 1, isForwarded: true }

    const sent = await this.sock.sendMessage(jid, content)
    const now = Date.now()
    if (sent?.key?.id) {
      await this.messageStore.persistMedia(jid, sent.key.id, file)
    }
    const media = mimeType.startsWith('image/')
      ? { kind: 'image' as const, mimetype: mimeType, caption, url: '' }
      : mimeType.startsWith('video/')
        ? { kind: 'video' as const, mimetype: mimeType, caption, url: '' }
        : mimeType.startsWith('audio/')
          ? { kind: 'audio' as const, mimetype: mimeType, caption: '', fileName, url: '' }
          : { kind: 'document' as const, mimetype: mimeType, caption, fileName, url: '' }
    const message = this.recordUiMessage({
      id: sent?.key?.id || `${now}`,
      jid,
      key: sent?.key || { remoteJid: jid, id: `${now}`, fromMe: true } as WAMessageKey,
      media,
      forwarded,
      fromMe: true,
      sender: 'אני',
      text: caption || fileName,
      type: mimeType.startsWith('image/') ? 'imageMessage' : mimeType.startsWith('video/') ? 'videoMessage' : mimeType.startsWith('audio/') ? 'audioMessage' : 'documentMessage',
      status: 'sent',
      timestamp: now
    })
    return message
  }

  // -------- Internal message helpers --------

  publicMessage(message: UiMessage): UiMessage {
    const { raw, ...safe } = message
    safe.downloadable = Boolean(message.media && raw?.message)
    if (isJidGroup(safe.jid)) {
      safe.senderNumber = this.contactCache.senderNumberFromKey(safe.key) || (looksLikeLidNumber(safe.senderNumber) ? '' : safe.senderNumber)
    }
    if (safe.senderNumber && isLidJid(safe.senderNumber)) safe.senderNumber = ''
    if (safe.quoted?.sender?.includes('@lid')) {
      safe.quoted = {
        ...safe.quoted,
        sender: this.contactCache.senderDisplayName({ participant: safe.quoted.sender }) || ''
      }
    }
    return safe
  }

  quotedPreview(message: UiMessage) {
    return {
      id: message.id,
      sender: message.fromMe ? 'אני' : this.contactCache.senderDisplayName(message.key, message.sender),
      text: message.text || '',
      mediaKind: message.media?.kind || message.viewOnceType
    }
  }

  recordUiMessage(item: UiMessage, options: { countUnread?: boolean } = {}): UiMessage {
    const sourceJid = item.jid
    item = { ...item, jid: this.contactCache.canonicalJid(sourceJid) }
    if (sourceJid !== item.jid) this.contactCache.mergeChatJid(sourceJid, item.jid)
    item.key = { remoteJid: item.jid, ...(item.key || {}) }
    const displayable = Boolean(item.text || item.media || item.contact || item.interactiveData || item.call || item.linkPreview) && !isTransportMessage(item.type)
    const messages = this.messages.get(item.jid) || []
    const existingIndex = messages.findIndex(message => message.id === item.id)
    const isNew = existingIndex < 0
    let storedMessage = item
    if (isNew) {
      messages.push(item)
    } else {
      storedMessage = mergeMessagePatch(messages[existingIndex], item)
      messages[existingIndex] = storedMessage
    }
    messages.sort((a, b) => a.timestamp - b.timestamp)
    while (messages.length > MEMORY_MESSAGE_LIMIT) messages.shift()
    this.messages.set(item.jid, messages)
    this.messageStore.persistSingleMessage(item.jid, storedMessage)

    this.contactCache.ensureChatMeta(item.jid, item.fromMe ? '' : item.sender).then(chat => {
      if (!chat) return
      const itemTimestamp = storedMessage.timestamp || Date.now()
      const isLatestKnown = itemTimestamp >= (chat.timestamp || 0)
      // Use the most up-to-date message data, not the snapshot captured at call time.
      // Receipt updates (via updateStoredMessage) may have modified the message in-place
      // after recordUiMessage returned but before this async callback runs.
      const currentMessages = this.messages.get(item.jid)
      const currentMessage = currentMessages?.find(m => m.id === storedMessage.id)
      const messageData = currentMessage || storedMessage
      console.log('📥 recordUiMessage callback:', 'found currentMessage:', Boolean(currentMessage), 'messageData.status:', messageData.status, 'chat.lastMessageStatus before:', chat.lastMessageStatus)
      if (displayable && isLatestKnown) {
        chat.lastMessage = messageData.text || (messageData.viewOnce ? viewOnceLabel(messageData.viewOnceType) : messageData.contact ? (messageData.contact.contacts?.length ? 'אנשי קשר' : 'איש קשר') : messageData.media?.kind === 'image' ? 'תמונה' : messageData.media?.kind === 'video' ? 'וידאו' : messageData.media?.kind === 'document' ? 'קובץ' : messageData.interactiveData ? (messageData.interactiveData.body || messageData.interactiveData.title || 'הודעה אינטראקטיבית') : isSupportedMessageType(messageData.type) ? messageData.type : 'הודעה לא נתמכת')
        chat.lastMessageFromMe = messageData.fromMe
        // Only overwrite status/receipt if the incoming data has meaningful values.
        // Incoming messages often have undefined status, which would erase the
        // correct delivery/read status set by receipt updates (updateChatFromEditedMessage).
        if (messageData.status != null && messageData.status !== '' && messageData.status !== 0) {
          chat.lastMessageStatus = messageData.status
        }
        if (messageData.receipt != null) {
          chat.lastMessageReceipt = messageData.receipt
        }
        if (messageData.userReceipt != null) {
          chat.lastMessageUserReceipt = messageData.userReceipt
        }
        chat.timestamp = itemTimestamp
      }
      if (displayable && options.countUnread && isNew) chat.unread = messageData.fromMe ? chat.unread : chat.unread + 1
      this.persistChat(chat)
      this.trimChatCache()
      if (isNew) this.events.emit('event', { type: 'message', bot: this.authKey, message: this.publicMessage(messageData), chat })
    })
    return this.publicMessage(storedMessage)
  }

  recordBaileysMessage(msg: WAMessage, options: { countUnread?: boolean } = {}) {
    const fromMe = this.contactCache.isOwnMessage(msg)
    const reaction = this.reactionMessagePatch(msg)
    if (reaction) {
      this.updateStoredMessage(reaction.jid, reaction.id, reaction.patch)
      return
    }

    const deleted = this.deletedMessagePatch(msg)
    if (deleted) {
      this.updateStoredMessage(deleted.jid, deleted.id, deleted.patch)
      return
    }

    const edited = this.editedMessagePatch(msg)
    if (edited) {
      this.updateStoredMessage(edited.jid, edited.id, edited.patch)
      return
    }

    const secretEncrypted = this.secretEncryptedMessagePatch(msg)
    if (secretEncrypted) {
      this.updateStoredMessage(secretEncrypted.jid, secretEncrypted.id, secretEncrypted.patch)
      return
    }

    const jid = this.contactCache.messageRemoteJid(msg)
    if (shouldIgnoreUiJid(jid)) return
    if (!fromMe && msg.pushName) {
      const participantIds = [
        msg.key.participant,
        (msg.key as any).participantAlt,
        (msg.key as any).participantPn
      ].filter(Boolean) as string[]
      const participantJid = participantIds[0]
      if (participantJid) {
        this.contactCache.rememberContact({
          id: participantJid,
          lid: participantIds.find(isLidJid),
          phoneNumber: participantIds.find(value => value.endsWith('@s.whatsapp.net')),
          notify: msg.pushName
        })
        for (const id of participantIds) sharedWhatsAppNames.set(id, msg.pushName)
      }
    }
    const callInfo = callInfoFromMessage(msg)
    if (callInfo) {
      this.recordUiMessage({
        id: callInfo.id,
        jid,
        key: { ...msg.key, remoteJid: jid } as WAMessageKey,
        call: callInfo.call,
        fromMe,
        sender: fromMe ? 'אני' : this.contactCache.senderDisplayName(msg.key, msg.pushName || jid),
        senderNumber: isJidGroup(jid) ? this.contactCache.participantPhone(msg) : '',
        text: callInfo.text,
        type: 'callMessage',
        timestamp: normalizeTimestamp(msg.messageTimestamp)
      }, options)
      return
    }

    const type = messageType(msg.message)
    const text = messageText(msg.message)
    const media = messageMedia(msg.message, type)
    let contact = messageContact(msg.message, type)
    // Enrich contact displayName from our contacts list when missing
    if (contact && !fromMe && !contact.displayName) {
      const senderJid = msg.key.participant || msg.key.remoteJidAlt || msg.key.remoteJid || ''
      const senderName = this.contactCache.senderDisplayName(msg.key, '')
      if (senderName) {
        contact = { ...contact, displayName: senderName }
      }
    }
    const linkPreview = messageLinkPreview(msg.message)
    const viewOnce = isViewOnceBaileysMessage(msg)
    const viewOnceType = media?.kind || viewOnceKindFromType(type)
    // Resolve @mentions in text: replace LID/phone placeholders with @[phone|name] format
    const mentionedJid = messageContext(msg.message)?.mentionedJid || []
    let displayText = text || (viewOnce ? viewOnceLabel(viewOnceType) : '')
    if (displayText && mentionedJid.length) {
      for (const targetJid of mentionedJid) {
        const rawId = String(targetJid).split('@')[0]?.split(':')[0] || ''
        const canonicalJid = this.contactCache.canonicalJid(targetJid)
        const canonicalId = String(canonicalJid).split('@')[0]?.split(':')[0] || ''
        const mentionIds = [...new Set([rawId, canonicalId].filter(Boolean))]
          .sort((a, b) => b.length - a.length)
          .map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        if (!mentionIds.length) continue

        const displayName = this.contactCache.senderDisplayName({ participant: targetJid }, '')
        const phone = canonicalJid && !canonicalJid.endsWith('@lid') && !canonicalJid.endsWith('@g.us')
          ? canonicalJid.replace(/@s\.whatsapp\.net$/, '')
          : ''
        const isMe = this.contactCache.isOwnJid(targetJid)
        const label = (isMe ? 'אני' : (displayName || phone || rawId)).replace(/\]/g, ')')
        const replacement = phone ? `@[${phone}|${label}]` : `@${label}`
        const mentionPattern = new RegExp(`(^|\\s)@(?:${mentionIds.join('|')})(?=$|[\\s.,!?;:()\\[\\]{}])`, 'g')
        displayText = displayText.replace(mentionPattern, (_match, prefix) => `${prefix}${replacement}`)
      }
    }
    if (!displayText && type === 'unknown' && !contact) return
    if (!displayText && !media && !contact && isTransportMessage(type)) return

    this.recordUiMessage({
      id: msg.key.id || `${Date.now()}`,
      jid,
      key: { ...msg.key, remoteJid: jid } as WAMessageKey,
      raw: viewOnce ? (msg.message ? unwrapMessageForMedia(msg) : undefined) : msg,
      quoted: this.quotedFromIncomingMessage(msg, jid),
      contact,
      media,
      linkPreview,
      viewOnce,
      viewOnceType,
      forwarded: isForwardedMessage(msg.message),
      fromMe,
      sender: fromMe ? 'אני' : this.contactCache.senderDisplayName(msg.key, msg.pushName || jid),
      senderNumber: isJidGroup(jid) ? this.contactCache.participantPhone(msg) : '',
      text: displayText,
      type,
      interactiveData: messageInteractiveData(msg.message),
      status: msg.status,
      timestamp: normalizeTimestamp(msg.messageTimestamp)
    }, options)
  }

  // -------- Patch helpers --------

  reactionMessagePatch(msg: WAMessage): { jid: string; id: string; patch: MessagePatch } | undefined {
    const reaction = getMessageContent(msg.message)?.reactionMessage
    if (!reaction?.key?.id) return
    const jid = this.contactCache.keyRemoteJid(reaction.key) || this.contactCache.messageRemoteJid(msg)
    if (shouldIgnoreUiJid(jid)) return
    const userJid = msg.key.fromMe ? 'me' : ((msg.key as any).participantAlt || msg.key.participant || msg.key.remoteJid || '')
    return {
      jid,
      id: reaction.key.id,
      patch: {
        reaction: {
          userJid,
          sender: this.contactCache.senderDisplayName(msg.key, msg.pushName || userJid),
          text: reaction.text || '',
          timestamp: normalizeTimestamp(reaction.senderTimestampMs || msg.messageTimestamp || Date.now())
        }
      }
    }
  }

  quotedFromIncomingMessage(msg: WAMessage, jid: string) {
    const context = messageContext(msg.message)
    if (!context?.quotedMessage || !context?.stanzaId) return undefined
    const stored = (this.messages.get(jid) || []).find(message => message.id === context.stanzaId)
    if (stored) return this.quotedPreview(stored)

    const quotedText = messageText(context.quotedMessage)
    const quotedType = messageType(context.quotedMessage)
    const quotedMedia = messageMedia(context.quotedMessage, quotedType)
    return {
      id: context.stanzaId,
      sender: this.contactCache.senderDisplayName({ participant: context.participant }),
      text: quotedText,
      mediaKind: quotedMedia?.kind || viewOnceKindFromType(quotedType) || (quotedType === 'stickerMessage' ? 'sticker' : undefined)
    }
  }

  editedMessagePatch(msg: WAMessage): { jid: string; id: string; patch: MessagePatch } | undefined {
    const protocol = getMessageContent(msg.message)?.protocolMessage
    if (!protocol?.editedMessage || !protocol?.key?.id) return
    const jid = this.contactCache.keyRemoteJid(protocol.key) || this.contactCache.messageRemoteJid(msg)
    if (shouldIgnoreUiJid(jid)) return
    return {
      jid,
      id: protocol.key.id,
      patch: messagePatchFromContent(protocol.editedMessage)
    }
  }

  secretEncryptedMessagePatch(msg: WAMessage): { jid: string; id: string; patch: MessagePatch } | undefined {
    const secret = getMessageContent(msg.message)?.secretEncryptedMessage
    const targetKey = secret?.targetMessageKey
    if (!targetKey?.id) return
    const jid = this.contactCache.keyRemoteJid(targetKey) || this.contactCache.messageRemoteJid(msg)
    if (shouldIgnoreUiJid(jid)) return
    return {
      jid,
      id: targetKey.id,
      patch: {
        edited: true,
        type: 'secretEncryptedMessage'
      }
    }
  }

  isRevokeProtocol(protocol: any) {
    return protocol?.type === 0 || protocol?.type === 'REVOKE'
  }

  deletedMessagePatch(msg: WAMessage): { jid: string; id: string; patch: MessagePatch } | undefined {
    const protocol = getMessageContent(msg.message)?.protocolMessage
    if (!this.isRevokeProtocol(protocol) || !protocol?.key?.id) return
    const jid = this.contactCache.keyRemoteJid(protocol.key) || this.contactCache.messageRemoteJid(msg)
    if (shouldIgnoreUiJid(jid)) return
    return {
      jid,
      id: protocol.key.id,
      patch: {
        deleted: true,
        deletedAt: normalizeTimestamp(protocol.timestampMs || msg.messageTimestamp || Date.now()),
        deletedBy: msg.key.participant || msg.key.remoteJid || ''
      }
    }
  }

  // -------- Message updates --------

  updateStoredMessage(jid: string, id: string, patch: MessagePatch) {
    jid = this.contactCache.canonicalJid(jid)
    patch = this.chatStore.normalizeMessagePatch(patch)
    const messages = this.messages.get(jid) || []
    const index = messages.findIndex(message => message.id === id)
    if (index >= 0) {
      messages[index] = this.chatStore.mergeMessagePatch(messages[index], patch)
      this.messages.set(jid, messages)
      this.messageStore.persistSingleMessage(jid, messages[index])
      this.chatStore.updateChatFromEditedMessage(jid, messages[index])
      this.events.emit('event', { type: 'message-update', bot: this.authKey, jid, id, patch })
      return
    }

    this.redis.get(this.messagePayloadKey(jid, id)).then(raw => {
      if (!raw) {
        return this.updateStoredMessageById(id, patch)
      }
      const message = this.chatStore.mergeMessagePatch(JSON.parse(raw), patch)
      this.messageStore.persistSingleMessage(jid, message)
      this.chatStore.updateChatFromEditedMessage(jid, message)
      this.events.emit('event', { type: 'message-update', bot: this.authKey, jid, id, patch })
    }).catch(() => {})
  }

  async updateStoredMessageById(id: string, patch: MessagePatch): Promise<boolean> {
    // First pass: search all in-memory chats (fast, no Redis)
    for (const [candidateJid, messages] of this.messages.entries()) {
      const index = messages.findIndex(message => message.id === id)
      if (index < 0) continue
      messages[index] = this.chatStore.mergeMessagePatch(messages[index], patch)
      this.messages.set(candidateJid, messages)
      this.messageStore.persistSingleMessage(candidateJid, messages[index])
      this.chatStore.updateChatFromEditedMessage(candidateJid, messages[index])
      this.events.emit('event', { type: 'message-update', bot: this.authKey, jid: candidateJid, id, patch })
      return true
    }

    // Second pass: scan ALL chat IDs in the index (not just top CHAT_LIMIT)
    const allChatIds = await this.redis.zrange(this.chatIndexKey, 0, -1)
    for (const candidateJid of allChatIds) {
      const raw = await this.redis.get(this.messagePayloadKey(candidateJid, id))
      if (!raw) continue
      const message = this.chatStore.mergeMessagePatch(JSON.parse(raw), patch)
      this.messageStore.persistSingleMessage(candidateJid, message)
      this.chatStore.updateChatFromEditedMessage(candidateJid, message)
      this.events.emit('event', { type: 'message-update', bot: this.authKey, jid: candidateJid, id, patch })
      return true
    }
    return false
  }

  // -------- Chat helpers --------

  persistChat(chat: UiChat) { this.chatStore.persistChat(chat) }
  trimChatCache() { this.chatStore.trimChatCache() }
  removeNonChat(jid: string) { this.chatStore.removeNonChat(jid) }
  async removeChatStore(jid: string) { await this.chatStore.removeChatStore(jid) }
  setChatUnread(jid: string, unread: number) { this.chatStore.setChatUnread(jid, unread) }

  async recordCallEvent(call: any) {
    const callId = String(call.id || '')
    let jid = callId ? this.callPeers.get(callId) : undefined
    if (!jid) {
      jid = await this.contactCache.callRemoteJid(call)
      if (jid && callId) this.callPeers.set(callId, jid)
    }
    if (!jid) return
    const status = String(call.status || 'call')
    const timestamp = call.date ? new Date(call.date).getTime() : Date.now()
    this.recordUiMessage({
      id: `call:${call.id}`,
      jid,
      key: { remoteJid: jid, id: `call:${call.id}`, fromMe: false } as WAMessageKey,
      call: {
        id: call.id,
        status,
        isVideo: Boolean(call.isVideo)
      },
      fromMe: false,
      sender: call.from || jid,
      senderNumber: isJidGroup(jid) && call.from ? displayPhone(this.contactCache.phoneForJid(call.from)) : '',
      text: this.chatStore.callStatusText(status, call.isVideo),
      type: 'callMessage',
      timestamp
    })
    if (callId && ['reject', 'timeout', 'terminate'].includes(status)) {
      this.callPeers.delete(callId)
    }
  }

  emitStatus() { this.events.emit('event', { type: 'connection', bot: this.authKey, status: this.status() }) }

  async syncExistingChatSettings() {
    if (!this.sock) return
    try {
      const lastSync = Number(await this.redis.get(this.chatSettingsSyncKey) || 0)
      const forceSnapshot = Date.now() - lastSync > CHAT_SETTINGS_RESYNC_INTERVAL_MS
      if (forceSnapshot) {
        await this.state.keys.set({ 'app-state-sync-version': { regular_high: null } })
      }
      await this.sock.resyncAppState(['regular_high'], true)
      await this.redis.set(this.chatSettingsSyncKey, String(Date.now()))
    } catch (err: any) {
      console.error(`${this.label}: failed syncing chat settings`, err.message)
    }
  }

  upsertChatFromBaileys(chatData: Partial<Chat>) { this.chatStore.upsertChatFromBaileys(chatData) }

  async applyChatUpdate(chatData: Partial<Chat>) {
    const sourceJid = chatData.id
    if (!isLidJid(sourceJid)) {
      this.upsertChatFromBaileys(chatData)
      return
    }
    const phoneJid = this.contactCache.findChatByLid(sourceJid) || await this.contactCache.resolveLidToPhone(sourceJid)
    if (phoneJid) {
      this.pendingChatSettings.delete(sourceJid)
      this.upsertChatFromBaileys({ ...chatData, id: phoneJid })
      return
    }
    if (this.chatStore.hasChatMuteInfo(chatData) || 'archived' in (chatData as any)) {
      this.pendingChatSettings.set(sourceJid, { ...(this.pendingChatSettings.get(sourceJid) || {}), ...chatData })
    }
  }

  processFullHistoryResponse(msg: WAMessage) {
    const response = getMessageContent(msg.message)?.protocolMessage?.peerDataOperationRequestResponseMessage
    if (response?.peerDataOperationRequestType !== proto.Message.PeerDataOperationRequestType.FULL_HISTORY_SYNC_ON_DEMAND) return
    for (const result of response.peerDataOperationResult || []) {
      const full = result.fullHistorySyncOnDemandRequestResponse
      if (!full || full.responseCode === undefined || full.responseCode === null) continue
      const code = Number(full.responseCode)
      const name = proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.FullHistorySyncOnDemandResponseCode[code]
      console.log(`${this.label}: full history phone response`, { code, name, requestId: full.requestMetadata?.requestId })
      this.messageStore.recordFullHistoryResponse(full.requestMetadata?.requestId || undefined, code, name || String(code))
      if (code !== 0) {
        console.error(`${this.label}: phone rejected history sync:`, name || code)
      }
    }
  }

  // -------- Socket lifecycle --------

  async startSock() {
    const version = (await fetchLatestBaileysVersion()).version
    const sock = makeWASocket({
      version,
      auth: this.state,
      defaultQueryTimeoutMs: WA_QUERY_TIMEOUT_MS,
      shouldIgnoreJid: jid => shouldIgnoreChatJid(jid),
      shouldSyncHistoryMessage: () => true,
      syncFullHistory
    })

    this.sock = sock
    this.chatStoreSocket.current = sock
    this.id = sock.user?.id || this.id

    sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        this.connection = 'qr'
        this.qr = qr
        this.emitStatus()
        console.log(`${this.label}: scan QR`)
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        this.id = sock.user?.id || this.id
        this.connection = 'open'
        this.qr = ''
        this.emitStatus()
        this.syncExistingChatSettings().catch(() => {})
        console.log(`${this.label}: connected to WhatsApp`)
        for (const chat of this.listChats()) {
          if (!chat.isGroup) {
            console.log(`${this.label}: subscribing to presence for (open)`, chat.jid)
            sock.presenceSubscribe(chat.jid).catch(err => console.error(`${this.label}: subscribe error`, err.message))
          }
        }
      }

      if (connection === 'close') {
        this.connection = 'close'
        this.emitStatus()
        console.log(`${this.label}: connection closed`, lastDisconnect?.error)

        const err: any = lastDisconnect?.error
        const status = err?.output?.statusCode || err?.status || err?.code || 'unknown'
        const shouldLogout =
          status === DisconnectReason.loggedOut ||
          /logged.?out|401|logout/i.test(String(status)) ||
          /invalid session|bad session|multi.*auth/i.test(String(err))

        try { sock?.end?.() } catch {}
        if (shouldLogout) {
          try {
            await this.purgeAccountData()
          } catch (purgeError: any) {
            console.error(`${this.label}: failed purging unlinked account data`, purgeError.message)
          }
        }

        if (this.currentWait) clearTimeout(this.currentWait)
        this.currentWait = setTimeout(() => this.startSock(), 5000)
      }
    })

    sock.ev.on('creds.update', this.saveCreds)

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, syncType, peerDataRequestSessionId }) => {
      for (const mapping of lidPnMappings || []) {
        if (!mapping.lid || !mapping.pn) continue
        const phone = normalizePhoneJid(mapping.pn)
        this.lidToPhone.set(mapping.lid, phone)
        this.contactCache.persistLidMapping(mapping.lid, phone)
        this.contactCache.mergeChatJid(mapping.lid, phone)
      }
      for (const contact of contacts) this.contactCache.upsertContact(contact)
      for (const chat of chats) this.upsertChatFromBaileys(chat)
      for (const message of messages) this.recordBaileysMessage(message)
      console.log(`${this.label}: history sync stored`, messages.length, 'messages', { syncType, peerDataRequestSessionId })
    })

    sock.ev.on('chats.upsert', items => {
      for (const chat of items) this.upsertChatFromBaileys(chat)
    })

    sock.ev.on('chats.update', async items => {
      for (const chat of items) {
        await this.applyChatUpdate(chat)
        // Ignore WhatsApp's unreadCount — it may count non-displayable messages
        // (missed calls, system messages) that don't correspond to actual unread
        // messages in our store. Rely on our own counting from recordUiMessage
        // and clearing from message-receipt.update (read receipts).
      }
    })

    sock.ev.on('messages.update', items => {
      for (const item of items) {
        const jid = this.contactCache.keyRemoteJid(item.key)
        if (!jid || !item.key.id) continue
        const patch: MessagePatch = { ...(item.update as Record<string, any>) }
        let replacementMessage: WAMessage | undefined
        if (patch.message === null || patch.messageStubType === 1 || patch.messageStubType === 'REVOKE') {
          patch.deleted = true
          patch.deletedAt = Date.now()
          delete (patch as any).message
          delete (patch as any).messageStubType
        }
        if ((item.update as any)?.message) {
          replacementMessage = { key: { ...item.key, remoteJid: jid }, message: (item.update as any).message, messageTimestamp: (item.update as any).messageTimestamp || Date.now() } as WAMessage
          Object.assign(patch, messagePatchFromContent((item.update as any).message))
          delete (patch as any).message
        }
        if (replacementMessage) {
          const type = messageType(replacementMessage.message)
          const text = messageText(replacementMessage.message)
          const media = messageMedia(replacementMessage.message, type)
          const contact = messageContact(replacementMessage.message, type)
          const linkPreview = messageLinkPreview(replacementMessage.message)
          const viewOnce = isViewOnceBaileysMessage(replacementMessage)
          const viewOnceType = media?.kind || viewOnceKindFromType(type)
          patch.raw = viewOnce ? (replacementMessage.message ? unwrapMessageForMedia(replacementMessage) : undefined) : replacementMessage
          patch.viewOnce = viewOnce
          if (viewOnceType) patch.viewOnceType = viewOnceType
          if (media) patch.media = media
          if (contact) patch.contact = contact
          if (linkPreview) patch.linkPreview = linkPreview
          if (text || viewOnce || contact) patch.text = text || viewOnceLabel(viewOnceType) || (contact?.displayName || '')
          if (type !== 'unknown') patch.type = type
          if (type === 'audioMessage') this.handleAudioTranscription(replacementMessage).catch(() => {})
        }
        this.updateStoredMessage(jid, item.key.id, patch)
      }
    })

    sock.ev.on('message-receipt.update', items => {
      for (const item of items) {
        const jid = this.contactCache.keyRemoteJid(item.key)
        if (!jid || !item.key.id) continue
        this.updateStoredMessage(jid, item.key.id, { receipt: item.receipt })
        const receipt = item.receipt || {}
        if (receipt.readTimestamp || receipt.playedTimestamp) {
          this.messageStore.getStoredMessage(jid, item.key.id)
            .then(message => {
              // Clear unread for incoming messages when a read receipt arrives,
              // regardless of which device generated the read (phone or own device).
              // The previous !isOwnReceipt check prevented clearing when the phone
              // read messages because isOwnReceipt only matches the bot's own JID.
              if (!message || message.fromMe) return
              this.setChatUnread(jid, 0)
            })
            .catch(() => {})
        }
      }
    })

    sock.ev.on('call', calls => {
      for (const call of calls) {
        this.recordCallEvent(call).catch(err => console.error(`${this.label}: failed recording call`, err.message))
      }
    })

    sock.ev.on('contacts.upsert', items => {
      for (const contact of items) this.contactCache.upsertContact(contact)
    })

    sock.ev.on('contacts.update', items => {
      for (const contact of items) this.contactCache.upsertContact(contact)
    })

    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (!lid || !pn) return
      const phone = normalizePhoneJid(pn)
      this.lidToPhone.set(lid, phone)
      this.contactCache.persistLidMapping(lid, phone)
      this.contactCache.mergeChatJid(lid, phone)
      const pending = this.pendingChatSettings.get(lid)
      if (pending) {
        this.pendingChatSettings.delete(lid)
        this.upsertChatFromBaileys({ ...pending, id: phone })
      }
      const chat = this.chats.get(lid)
      if (!chat) return
      this.contactCache.enrichChat(chat)
      this.chats.set(chat.jid, chat)
      this.persistChat(chat)
      this.events.emit('event', { type: 'chat', bot: this.authKey, chat })
    })

    sock.ev.on('presence.update', async ({ id, to, presences }) => {
      if (!id) return
      let chat = this.chats.get(id)
      if (!chat) {
        if (to) {
          chat = this.chats.get(to)
          if (!chat) {
            const phoneJid = this.contactCache.findChatByLid(to)
            if (phoneJid) chat = this.chats.get(phoneJid)
          }
        }
      }
      if (!chat) {
        const phoneJid = this.contactCache.findChatByLid(id)
        if (phoneJid) chat = this.chats.get(phoneJid)
      }
      if (!chat) {
        const resolvedPhone = await this.contactCache.resolveLidToPhone(id)
        if (resolvedPhone) {
          chat = this.chats.get(resolvedPhone)
        }
      }
      if (!chat) {
        return
      }
      const presencesResolved: Record<string, any> = { ...presences }
      for (const [participant, data] of Object.entries(presences)) {
        if (isLidJid(participant)) {
          const phone = this.lidToPhone.get(participant) || await this.contactCache.resolveLidToPhone(participant)
          if (phone) {
            presencesResolved[phone] = data
          }
        }
      }
      if (chat.isGroup) {
        const hasParticipantContact = Object.keys(presencesResolved).some(p => {
          const contact = this.contactCache.contactForJid(p)
          return Boolean(contactName(contact))
        })
        if (!hasParticipantContact) {
          await this.contactCache.rememberGroupParticipants(chat.jid).catch(() => {})
        }
      }
      this.contactCache.processPresenceData(chat, presencesResolved)
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        this.processFullHistoryResponse(m)
        this.recordBaileysMessage(m, { countUnread: type === 'notify' })
        try { await this.handleAudioTranscription(m) } catch {}
      }
    })
  }

  async handleAudioTranscription(msg: any) {
    if (!msg.message) return
    const type = messageType(msg.message)
    if (type !== 'audioMessage') return
    const mediaMsg = unwrapMessageForMedia(msg)

    const remoteJid = msg.key.remoteJidAlt || msg.key.remoteJid!
    const fromGroup = isJidGroup(remoteJid)
    const id = msg.key.id
    console.log(`${this.label}: incoming audio ${id} from ${remoteJid}`)

    if (this.transcriptionCache.has(id)) return

    const tryOnce = async () => {
      this.transcriptionCache.set(id, 'wait')
      const sentMsg = await this.sock!.sendMessage(remoteJid, { text: '📝 מתמלל...' }, { quoted: msg })
      const buffer = await downloadMediaMessage(
        mediaMsg,
        'buffer',
        {},
        { logger: this.sock!.logger!, reuploadRequest: this.sock!.updateMediaMessage }
      ) as Buffer

      const transcript = await transcribeBuffer(buffer)
      this.transcriptionCache.set(id, transcript)
      if (this.transcriptionCache.size > CACHE_LIMIT) {
        const oldestKey = this.transcriptionCache.keys().next().value
        if (oldestKey) this.transcriptionCache.delete(oldestKey)
      }

      await this.sock!.sendMessage(remoteJid, {
        edit: sentMsg.key,
        text: transcript ? `📝 תמלול:\n${transcript}` : 'לא הצלחתי לתמלל.'
      })
    }

    try {
      await tryOnce()
    } catch (e: any) {
      const msgTxt = String(e?.message || e)
      const stackTxt = String(e?.stack || '')
      const looksLikeGroupDecrypt =
        /InvalidMessageException|Bad MAC|No matching sessions/i.test(msgTxt) ||
        /sender-key-state|group_cipher|GroupCipher|reading 'push'/i.test(msgTxt + ' ' + stackTxt)

      if (fromGroup && looksLikeGroupDecrypt) {
        const last = this.healedGroups.get(remoteJid) || 0
        const now = Date.now()
        if (now - last > 10 * 60 * 1000) {
          this.healedGroups.set(remoteJid, now)
          await deleteRedisPattern(this.redis, `${this.authKey}:sender-key*${remoteJid}*`)
        }
        try { await tryOnce() } catch (e2: any) {
          console.error(`${this.label}: self-heal failed`, String(e2?.message || e2))
        }
      } else {
        console.error(`${this.label}: audio transcription failed`, msgTxt)
      }
    }
  }

  async init() {
    await this.contactCache.restoreUiCache()
    // Recalculate unread counts from actual messages on restore.
    // Old chats persisted in Redis may have stale chat.unread values
    // (e.g., from WhatsApp's unreadCount override before the fix).
    // Reset unread to 0 for chats where no non-fromMe messages exist
    // in the restored message store, or no messages at all.
    for (const [jid, chat] of this.chats) {
      if (chat.unread > 0) {
        const msgs = this.messages.get(jid)
        // Reset if: no messages in store, OR all messages are fromMe
        if (!msgs || !msgs.some(m => !m.fromMe)) {
          chat.unread = 0
        }
      }
    }
    await this.startSock()
  }
}

export async function createBot(authKey: string, label: string, botId = '') {
  const { state, saveCreds, redis } = await useRedisAuthStateWithHSet(redisOptions, authKey, console.log)

  const bot = new Bot(authKey, label, state, saveCreds, redis, botId)
  await bot.init()
  return bot
}
