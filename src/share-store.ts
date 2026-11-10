import crypto from 'crypto'

// Public, read-only share tokens for a single chat.
//
// A "chat" is any WhatsApp conversation the bot sees: a group or a private
// (1:1) chat. A token grants anonymous read access (no UI session) to the last
// N messages of exactly one chat. Tokens live in Redis so they survive restarts
// and are shared across processes. This is intended for AI/automation
// consumers, so the payload is plain JSON.

export type ShareLink = {
  token: string
  bot: string
  jid: string
  label?: string
  createdAt: number
}

const TOKEN_BYTES = 24

export class ShareStore {
  private redis: any
  private tokenKey: (token: string) => string
  private chatKey: (bot: string, jid: string) => string
  // Older versions indexed links per "group". Keep reading (and migrating off)
  // that index so links created before this became chat-scoped still list.
  private legacyChatKey: (bot: string, jid: string) => string

  constructor(redis: any, prefix = 'ui') {
    this.redis = redis
    this.tokenKey = (token: string) => `${prefix}:share:${token}`
    this.chatKey = (bot: string, jid: string) => `${prefix}:share-chat:${bot}:${jid}`
    this.legacyChatKey = (bot: string, jid: string) => `${prefix}:share-group:${bot}:${jid}`
  }

  private static newToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  }

  /** Tokens listed for a chat, in both the current and the legacy index. */
  private async chatTokens(bot: string, jid: string): Promise<{ tokens: string[], legacy: string[] }> {
    const [tokens, legacy] = await Promise.all([
      this.redis.smembers(this.chatKey(bot, jid)),
      this.redis.smembers(this.legacyChatKey(bot, jid))
    ])
    return { tokens: tokens || [], legacy: legacy || [] }
  }

  /** Create (and persist) a new share token for a chat (group or private). */
  async create(bot: string, jid: string, label = ''): Promise<ShareLink> {
    const link: ShareLink = {
      token: ShareStore.newToken(),
      bot,
      jid,
      label: label || undefined,
      createdAt: Date.now()
    }
    await this.redis
      .multi()
      .set(this.tokenKey(link.token), JSON.stringify(link))
      .sadd(this.chatKey(bot, jid), link.token)
      .exec()
    return link
  }

  /** Resolve a token to its share link, or undefined when unknown/revoked. */
  async get(token: string): Promise<ShareLink | undefined> {
    if (!token) return undefined
    const raw = await this.redis.get(this.tokenKey(token))
    if (!raw) return undefined
    try {
      const link = JSON.parse(raw) as ShareLink
      if (!link?.bot || !link?.jid) return undefined
      return link
    } catch {
      return undefined
    }
  }

  /** List the active links for one chat (newest first). */
  async list(bot: string, jid: string): Promise<ShareLink[]> {
    const { tokens, legacy } = await this.chatTokens(bot, jid)
    const allTokens = [...new Set([...tokens, ...legacy])]
    if (!allTokens.length) return []
    const links = await Promise.all(allTokens.map(token => this.get(token)))
    const alive = links.filter((link): link is ShareLink => Boolean(link))
    // Drop tokens whose payload vanished (partial write / manual deletion).
    const dead = allTokens.filter((_, index) => !links[index])
    if (dead.length) {
      const pipeline = this.redis.multi()
      pipeline.srem(this.chatKey(bot, jid), ...dead)
      if (legacy.length) pipeline.srem(this.legacyChatKey(bot, jid), ...dead)
      await pipeline.exec()
    }
    // Move legacy-indexed links onto the chat index.
    const migrated = alive.filter(link => legacy.includes(link.token)).map(link => link.token)
    if (migrated.length) await this.redis.multi().sadd(this.chatKey(bot, jid), ...migrated).exec()
    return alive.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Revoke a single token. Returns true if it existed. */
  async delete(token: string): Promise<boolean> {
    const link = await this.get(token)
    if (!link) return false
    await this.redis
      .multi()
      .del(this.tokenKey(token))
      .srem(this.chatKey(link.bot, link.jid), token)
      .srem(this.legacyChatKey(link.bot, link.jid), token)
      .exec()
    return true
  }
}
