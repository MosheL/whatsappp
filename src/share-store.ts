import crypto from 'crypto'

// Public, read-only share tokens for a single group.
//
// A token grants anonymous read access (no UI session) to the last N messages
// of exactly one group. Tokens live in Redis so they survive restarts and are
// shared across processes. This is intended for AI/automation consumers, so the
// payload is plain JSON.

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
  private groupKey: (bot: string, jid: string) => string

  constructor(redis: any, prefix = 'ui') {
    this.redis = redis
    this.tokenKey = (token: string) => `${prefix}:share:${token}`
    this.groupKey = (bot: string, jid: string) => `${prefix}:share-group:${bot}:${jid}`
  }

  private static newToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  }

  /** Create (and persist) a new share token for a group. */
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
      .sadd(this.groupKey(bot, jid), link.token)
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

  /** List the active links for one group (newest first). */
  async list(bot: string, jid: string): Promise<ShareLink[]> {
    const tokens: string[] = await this.redis.smembers(this.groupKey(bot, jid))
    if (!tokens?.length) return []
    const links = await Promise.all(tokens.map(token => this.get(token)))
    // Drop tokens whose payload vanished (partial write / manual deletion).
    const alive = links.filter((link): link is ShareLink => Boolean(link))
    if (alive.length !== tokens.length) {
      const dead = tokens.filter((_, index) => !links[index])
      if (dead.length) await this.redis.srem(this.groupKey(bot, jid), ...dead)
    }
    return alive.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Revoke a single token. Returns true if it existed. */
  async delete(token: string): Promise<boolean> {
    const link = await this.get(token)
    if (!link) return false
    await this.redis
      .multi()
      .del(this.tokenKey(token))
      .srem(this.groupKey(link.bot, link.jid), token)
      .exec()
    return true
  }
}