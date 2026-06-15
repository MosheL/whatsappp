import {
  downloadMediaMessage
} from '@whiskeysockets/baileys'
import type { UiMessage, UiChat, MessagePatch, MessageStoreDeps } from './types.ts'
import { unwrapMessageForMedia } from './message-processor.ts'

export class MessageStore {
  private deps: MessageStoreDeps
  private fullHistoryRequest?: { id: string; metadataId: string; requestedAt: number }
  private fullHistoryRequestPromise?: Promise<string>
  private fullHistoryError?: { metadataId?: string; error: Error }

  constructor(deps: MessageStoreDeps) {
    this.deps = deps
  }

  // -------- Key helpers --------

  async getStoredMessage(jid: string, id: string): Promise<UiMessage | undefined> {
    const { redis, messagePayloadKey, messages, canonicalJid } = this.deps
    jid = canonicalJid(jid)
    const memory = messages.get(jid) || []
    const inMemory = memory.find(m => m.id === id)
    if (inMemory) return inMemory
    const raw = await redis.get(messagePayloadKey(jid, id))
    return raw ? JSON.parse(raw) : undefined
  }

  async getOldestStoredMessage(jid: string): Promise<UiMessage | undefined> {
    const { redis, messageIndexKey, messagePayloadKey, messages, canonicalJid } = this.deps
    jid = canonicalJid(jid)
    const ids = await redis.zrange(messageIndexKey(jid), 0, 0)
    if (ids.length) {
      const raw = await redis.get(messagePayloadKey(jid, ids[0]))
      if (raw) return JSON.parse(raw)
    }
    const memory = messages.get(jid)
    return memory?.length ? [...memory].sort((a, b) => a.timestamp - b.timestamp)[0] : undefined
  }

  async getStoredMessages(jid: string, limit: number): Promise<UiMessage[]> {
    const { redis, messageIndexKey, canonicalJid } = this.deps
    jid = canonicalJid(jid)
    const ids = await redis.zrange(messageIndexKey(jid), -limit, -1)
    const raw = await this.loadMessagePayloads(jid, ids)
    return raw
      .filter(Boolean)
      .map(item => JSON.parse(item!))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  async loadMessagePayloads(jid: string, ids: string[]): Promise<string[]> {
    const { redis, messagePayloadKey, messageIndexKey } = this.deps
    if (!ids.length) return []
    const raw = await redis.mget(...ids.map(id => messagePayloadKey(jid, id)))
    const missingIds = ids.filter((_, index) => !raw[index])
    if (missingIds.length) await redis.zrem(messageIndexKey(jid), ...missingIds)
    return raw
  }

  // -------- Persistence --------

  persistSingleMessage(jid: string, message: UiMessage): void {
    const { redis, messagePayloadKey, messageIndexKey } = this.deps
    redis
      .multi()
      .set(messagePayloadKey(jid, message.id), JSON.stringify(message))
      .zadd(messageIndexKey(jid), message.timestamp || 0, message.id)
      .exec()
      .then(() => this.trimMessageStore(jid))
      .catch((err: any) => console.error(`${this.deps.label}: failed saving message`, err.message))
  }

  async trimMessageStore(jid: string): Promise<void> {
    const { redis, messageIndexKey, messagePayloadKey, STORED_MESSAGE_LIMIT } = this.deps
    if (STORED_MESSAGE_LIMIT <= 0) return
    const staleIds = await redis.zrange(messageIndexKey(jid), 0, -(STORED_MESSAGE_LIMIT + 1))
    if (!staleIds.length) return
    const tx = redis.multi().zrem(messageIndexKey(jid), ...staleIds)
    for (const id of staleIds) tx.del(messagePayloadKey(jid, id))
    await tx.exec()
  }

  async removeMessageStore(jid: string): Promise<void> {
    const { redis, messageIndexKey, messagePayloadKey } = this.deps
    const ids = await redis.zrange(messageIndexKey(jid), 0, -1)
    const tx = redis.multi().del(messageIndexKey(jid))
    for (const id of ids) tx.del(messagePayloadKey(jid, id))
    await tx.exec()
  }

  async mergeMessageStore(fromJid: string, toJid: string): Promise<void> {
    const { redis, messageIndexKey, messagePayloadKey, messages } = this.deps
    if (!fromJid || !toJid || fromJid === toJid) return
    const ids = await redis.zrange(messageIndexKey(fromJid), 0, -1)
    const raw = ids.length ? await redis.mget(...ids.map(id => messagePayloadKey(fromJid, id))) : []
    const tx = redis.multi()
    for (let index = 0; index < ids.length; index++) {
      if (!raw[index]) continue
      const message = JSON.parse(raw[index])
      message.jid = toJid
      message.key = { ...(message.key || {}), remoteJid: toJid }
      tx
        .set(messagePayloadKey(toJid, ids[index]), JSON.stringify(message))
        .zadd(messageIndexKey(toJid), message.timestamp || 0, ids[index])
        .del(messagePayloadKey(fromJid, ids[index]))
    }
    tx.del(messageIndexKey(fromJid))
    await tx.exec()

    const merged = new Map<string, UiMessage>()
    for (const message of [...(messages.get(toJid) || []), ...(messages.get(fromJid) || [])]) {
      merged.set(message.id, { ...message, jid: toJid, key: { ...(message.key || {}), remoteJid: toJid } })
    }
    const recent = [...merged.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-this.deps.MEMORY_MESSAGE_LIMIT)
    messages.delete(fromJid)
    if (recent.length) messages.set(toJid, recent)
  }

  async persistMedia(jid: string, messageId: string, buffer: Buffer): Promise<void> {
    const { redis, mediaCacheKey, MEDIA_CACHE_TTL_SECONDS, canonicalJid } = this.deps
    try {
      await redis.set(mediaCacheKey(canonicalJid(jid), messageId), buffer, 'EX', MEDIA_CACHE_TTL_SECONDS)
    } catch (err: any) {
      console.error(`${this.deps.label}: failed saving media cache`, err.message)
    }
  }

  async getMedia(jid: string, messageId: string): Promise<{ buffer: Buffer; mimetype: string; fileName: string }> {
    const { redis, mediaCacheKey, canonicalJid, getSock } = this.deps
    const sock = getSock()
    if (!sock) throw new Error('Socket not connected')
    jid = canonicalJid(jid)
    const cached = await redis.getBuffer(mediaCacheKey(jid, messageId))
    const message = await this.getStoredMessage(jid, messageId)
    if (!message) throw new Error('Media message not found')
    if (cached) {
      return {
        buffer: cached,
        mimetype: message.media?.mimetype || 'application/octet-stream',
        fileName: message.media?.fileName || message.text || message.id
      }
    }
    if (!message.media) throw new Error('Media is not ready yet')
    if (!message.raw?.message) throw new Error('Media is not cached yet')
    const buffer = await downloadMediaMessage(
      unwrapMessageForMedia(message.raw),
      'buffer',
      {},
      { logger: sock.logger!, reuploadRequest: sock.updateMediaMessage }
    ) as Buffer
    await this.persistMedia(jid, messageId, buffer)
    return {
      buffer,
      mimetype: message.media?.mimetype || 'application/octet-stream',
      fileName: message.media?.fileName || message.text || message.id
    }
  }

  // -------- History sync --------

  async requestFullHistorySync(): Promise<string> {
    const { getSock, label, HISTORY_SYNC_WAIT_MS } = this.deps
    const sock = getSock()
    if (!sock) throw new Error('Socket not connected')
    if (this.fullHistoryRequest && Date.now() - this.fullHistoryRequest.requestedAt < HISTORY_SYNC_WAIT_MS) {
      return this.fullHistoryRequest.id
    }
    if (this.fullHistoryRequestPromise) return this.fullHistoryRequestPromise

    this.fullHistoryRequestPromise = (async () => {
      const { proto } = await import('@whiskeysockets/baileys')
      const metadataId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      console.log(`${label}: requesting full history from phone`, { requestId: metadataId })
      const id = await sock.sendPeerDataOperationMessage({
        fullHistorySyncOnDemandRequest: {
          requestMetadata: { requestId: metadataId },
          historySyncConfig: {
            storageQuotaMb: 10240,
            inlineInitialPayloadInE2EeMsg: true,
            supportBotUserAgentChatHistory: true,
            supportCagReactionsAndPolls: true,
            supportBizHostedMsg: true,
            supportRecentSyncChunkMessageCountTuning: true,
            supportHostedGroupMsg: true,
            supportFbidBotChatHistory: true,
            supportMessageAssociation: true
          }
        },
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.FULL_HISTORY_SYNC_ON_DEMAND
      })
      this.fullHistoryRequest = { id, metadataId, requestedAt: Date.now() }
      this.fullHistoryError = undefined
      return id
    })()
    try {
      return await this.fullHistoryRequestPromise
    } finally {
      this.fullHistoryRequestPromise = undefined
    }
  }

  recordFullHistoryResponse(metadataId: string | undefined, code: number, name: string): void {
    if (metadataId && this.fullHistoryRequest?.metadataId && metadataId !== this.fullHistoryRequest.metadataId) return
    if (code === 0) {
      this.fullHistoryError = undefined
      return
    }
    const error: any = new Error(`Phone rejected history sync: ${name || code}`)
    error.statusCode = 409
    this.fullHistoryError = { metadataId, error }
  }

  async waitForOlderMessages(jid: string, before: number, timeoutMs: number): Promise<UiMessage[]> {
    const deadline = Date.now() + Math.max(1000, timeoutMs)
    while (Date.now() < deadline) {
      const messages = await this.getMessages(jid, 100, before)
      if (messages.length) return messages
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    return []
  }

  async waitForStoredMessages(jid: string, timeoutMs: number): Promise<UiMessage[]> {
    const deadline = Date.now() + Math.max(1000, timeoutMs)
    while (Date.now() < deadline) {
      if (this.fullHistoryError) throw this.fullHistoryError.error
      const messages = await this.getMessages(jid, 100)
      if (messages.length) return messages
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    return []
  }

  // -------- Public message API --------

  async getMessages(jid: string, limit = 300, before?: number): Promise<UiMessage[]> {
    const { redis, messageIndexKey, canonicalJid, publicMessage } = this.deps
    jid = canonicalJid(jid)
    const safeLimit = Math.max(1, Math.min(limit, 500))
    const ids = before
      ? await redis.zrevrangebyscore(messageIndexKey(jid), `(${before}`, '-inf', 'LIMIT', 0, safeLimit)
      : await redis.zrange(messageIndexKey(jid), -safeLimit, -1)
    const raw = await this.loadMessagePayloads(jid, ids)
    return raw
      .filter(Boolean)
      .map(item => publicMessage(JSON.parse(item!)))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  async restoreRecentMessages(): Promise<void> {
    const { redis, messageIndexKey, MEMORY_MESSAGE_LIMIT, messages, listChats } = this.deps
    const recentChats = listChats().slice(0, 80)
    await Promise.all(recentChats.map(async chat => {
      const messageIds = await redis.zrange(messageIndexKey(chat.jid), -MEMORY_MESSAGE_LIMIT, -1)
      const rawMessages = await this.loadMessagePayloads(chat.jid, messageIds)
      const msgs = rawMessages
        .filter(Boolean)
        .map(item => JSON.parse(item!))
        .sort((a, b) => a.timestamp - b.timestamp)
      if (msgs.length) messages.set(chat.jid, msgs)
    }))
  }
}
