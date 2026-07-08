import type { UiChat, UiMessage, MessagePatch, ChatStoreDeps } from './types.ts'
import type { proto } from '@whiskeysockets/baileys'
import { isJidGroup } from '@whiskeysockets/baileys'
import type { Chat } from '@whiskeysockets/baileys/lib/Types/Chat.js'
import { shouldIgnoreUiJid } from './contact-cache.ts'
import { callTypeLabel } from './message-processor.ts'
import { messageStatusRank, mergeMessagePatch, reactionUserKey } from './message-utils.ts'

export class ChatStore {
  private deps: ChatStoreDeps

  constructor(deps: ChatStoreDeps) {
    this.deps = deps
  }

  // -------- Persistence --------

  persistChat(chat: UiChat): void {
    const { redis, chatCacheKey, chatIndexKey, CHAT_LIMIT, label } = this.deps
    const storedChat = { ...chat }
    delete storedChat.typing
    delete storedChat.typingTimestamp
    redis
      .multi()
      .hset(chatCacheKey, chat.jid, JSON.stringify(storedChat))
      .zadd(chatIndexKey, chat.timestamp || 0, chat.jid)
      .zremrangebyrank(chatIndexKey, 0, -(CHAT_LIMIT + 1))
      .exec()
      .catch((err: any) => console.error(`${label}: failed saving chat`, err.message))
  }

  trimChatCache(): void {
    const { redis, chatCacheKey, chatIndexKey, CHAT_LIMIT, chats, listChats } = this.deps
    const stale = listChats().slice(CHAT_LIMIT)
    for (const chat of stale) {
      chats.delete(chat.jid)
      redis.multi().hdel(chatCacheKey, chat.jid).zrem(chatIndexKey, chat.jid).exec().catch(() => {})
    }
  }

  removeNonChat(jid: string): void {
    const { redis, chatCacheKey, chatIndexKey, chats } = this.deps
    chats.delete(jid)
    redis.multi().hdel(chatCacheKey, jid).zrem(chatIndexKey, jid).exec().catch(() => {})
  }

  async removeChatStore(jid: string): Promise<void> {
    const { redis, chatCacheKey, chatIndexKey, chats } = this.deps
    chats.delete(jid)
    redis.multi()
      .hdel(chatCacheKey, jid)
      .zrem(chatIndexKey, jid)
      .exec()
  }

  setChatUnread(jid: string, unread: number): void {
    const { canonicalJid, chats, onChatEvent } = this.deps
    jid = canonicalJid(jid)
    const chat = chats.get(jid)
    if (!chat) return
    chat.unread = Math.max(0, Number(unread || 0))
    this.persistChat(chat)
    onChatEvent(chat)
  }

  // -------- Message patching --------

  normalizeMessagePatch(patch: MessagePatch): MessagePatch {
    const { isOwnReceipt } = this.deps
    const next = { ...patch }
    const receipt = next.receipt
    if (receipt) {
      next.receipt = { ...receipt, own: isOwnReceipt(receipt) }
      if (!next.receipt.own && (receipt.readTimestamp || receipt.playedTimestamp)) next.status = 4
      else if (receipt.receiptTimestamp || receipt.deliveryTimestamp) next.status = 3
      next.userReceipt = this.mergeUserReceipt(next.userReceipt, next.receipt)
    }
    return next
  }

  messageStatusRank = messageStatusRank

  mergeMessagePatch(message: UiMessage, patch: MessagePatch): UiMessage {
    return mergeMessagePatch(message, patch)
  }

  reactionUserKey = reactionUserKey

  mergeUserReceipt(existing: proto.IUserReceipt[] | undefined, receipt: proto.IUserReceipt): proto.IUserReceipt[] {
    const list = Array.isArray(existing) ? [...existing] : []
    const userJid = receipt?.userJid || receipt?.participant
    if (!userJid) return list.length ? list : [receipt]
    const index = list.findIndex(item => item.userJid === userJid || item.participant === userJid)
    if (index >= 0) list[index] = { ...list[index], ...receipt }
    else list.push(receipt)
    return list
  }

  updateChatFromEditedMessage(jid: string, message: UiMessage): void {
    const { chats, onChatEvent } = this.deps
    const chat = chats.get(jid)
    if (!chat || !message) return
    // Allow 10s tolerance for timing differences. chat.timestamp may reflect a
    // non-displayable incoming message (e.g. presence, system) that is slightly
    // newer than the last displayable message. Without this tolerance, receipt
    // updates for the last displayable message are silently dropped.
    const msgTs = message.timestamp || 0
    const chatTs = chat.timestamp || 0
    if (msgTs < chatTs - 10000) return
    const displayable = Boolean(message.text || message.media || message.contact || message.interactiveData || message.call || message.linkPreview)
    chat.lastMessage = message.deleted
      ? 'הודעה נמחקה'
      : message.text || (message.viewOnce ? '' : message.contact ? (message.contact.contacts?.length ? 'אנשי קשר' : 'איש קשר') : message.media?.kind === 'image' ? 'תמונה' : message.media?.kind === 'video' ? 'וידאו' : message.media?.kind === 'document' ? 'קובץ' : message.interactiveData ? (message.interactiveData.body || message.interactiveData.title || 'הודעה אינטראקטיבית') : message.type)
    chat.lastMessageFromMe = message.fromMe
    chat.lastMessageStatus = message.status
    chat.lastMessageReceipt = message.receipt
    chat.lastMessageUserReceipt = message.userReceipt
    // Only update chat.timestamp for displayable messages (text, media).
    // Non-displayable messages (e.g. presence updates, system messages, or
    // receipt-only updates) should not shift the chat timestamp forward, as
    // that would cause receipt updates for the last displayable message to
    // fail the timestamp check in subsequent calls.
    if (displayable) {
      chat.timestamp = message.timestamp || chat.timestamp
    }
    this.persistChat(chat)
    onChatEvent(chat)
  }

  // -------- Call status --------

  callStatusText(status: string, isVideo?: boolean): string {
    const base = callTypeLabel(isVideo)
    if (status === 'offer') return `${base} נכנסת`
    if (status === 'ringing') return `${base} מצלצלת`
    if (status === 'accept') return `${base} נענתה`
    if (status === 'reject') return `${base} נדחתה`
    if (status === 'timeout') return `${base} לא נענתה`
    if (status === 'terminate') return `${base} הסתיימה`
    return base
  }

  // -------- Chat mute --------

  isChatMuted(chatData: Record<string, any>): boolean {
    const raw = chatData?.muteEndTime ?? chatData?.muteEndTimestamp ?? chatData?.mutedUntil ?? chatData?.muteEnd ?? chatData?.mute
    if (raw === true || raw === -1 || raw === 'Infinity' || raw === 'ON') return true
    if (raw === false || raw === 'OFF') return false
    const value = typeof raw === 'object' && raw?.low ? raw.low : Number(raw || 0)
    if (!value) return false
    const millis = value > 10_000_000_000 ? value : value * 1000
    return millis > Date.now()
  }

  hasChatMuteInfo(chatData: Record<string, any>): boolean {
    return ['muteEndTime', 'muteEndTimestamp', 'mutedUntil', 'muteEnd', 'mute'].some(key => key in (chatData || {}))
  }

  // -------- Chat upsert --------

  upsertChatFromBaileys(chatData: Partial<Chat>): void {
    const { chats, canonicalJid, onChatEvent } = this.deps
    const jid = chatData.id ? canonicalJid(chatData.id) : ''
    if (!jid || shouldIgnoreUiJid(jid)) return

    const existing = chats.get(jid)
    const chat: UiChat = existing || {
      jid,
      displayJid: jid,
      phoneNumber: '',
      name: '',
      lastMessage: '',
      timestamp: 0,
      unread: 0,
      isGroup: isJidGroup(jid),
      isMuted: false,
      isArchived: false
    }

    if (this.hasChatMuteInfo(chatData)) {
      chat.isMuted = this.isChatMuted(chatData)
    }
    if ('archived' in chatData) {
      chat.isArchived = Boolean(chatData.archived)
    }

    if (chatData.name && !chatData.name.includes('@')) chat.name = chatData.name
    if (chatData.ephemeralSettings?.ephemeralExpType === 'permanent') chat.isMuted = true
    if (chatData.ephemeralSettings?.ephemeralExpType === 'disappearing') chat.isMuted = false

    chats.set(jid, chat)
    this.persistChat(chat)
    onChatEvent(chat)
  }

  async syncExistingChatSettings(): Promise<void> {
    // Deprecated — now handled directly by Bot.syncExistingChatSettings
  }
}
