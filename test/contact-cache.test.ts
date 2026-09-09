import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContactCache, contactName, normalizePhoneJid, looksLikeJid, whatsappName } from '../src/contact-cache.ts'

test('looksLikeJid distinguishes JIDs from real names that contain @', () => {
  assert.equal(looksLikeJid('123456789012345@s.whatsapp.net'), true)
  assert.equal(looksLikeJid('123456789@g.us'), true)
  assert.equal(looksLikeJid('Work @ Home'), false)
  assert.equal(looksLikeJid('Friends & Family'), false)
  assert.equal(looksLikeJid('123-456@example.com'), false)
  assert.equal(looksLikeJid(''), false)
})

test('upserting group metadata keeps a subject containing @ and overwrites a stale name', () => {
  const jid = '9725000000000-1234@g.us'
  const chats = new Map([[jid, { jid, name: 'Old Name', isGroup: true, timestamp: 1 }]])
  const persisted: any[] = []
  const emitted: any[] = []
  const cache = new ContactCache({
    redis: {},
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: value => value,
    groupMetadataCacheMs: 1000,
    getSock: () => undefined,
    getOwnId: () => '',
    contacts: new Map(),
    lidToPhone: new Map(),
    chats,
    onChatEvent: chat => emitted.push(chat),
    onChatMerge: () => {},
    loadAvatar: async () => {},
    persistChat: chat => persisted.push(chat),
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })

  cache.upsertGroupMetadata(jid, { subject: 'Work @ Home', participantCount: 12 })
  assert.equal(chats.get(jid)?.name, 'Work @ Home')
  assert.equal(chats.get(jid)?.participantCount, 12)
  assert.equal(persisted.length, 1)
  assert.equal(emitted.length, 1)
})

test('enrichChat keeps a group name that contains @', () => {
  const jid = '919123000000-77@g.us'
  const chat: any = { jid, displayJid: jid, name: 'Design @ Home', isGroup: true }
  const cache = new ContactCache({
    redis: {},
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: value => value,
    groupMetadataCacheMs: 1000,
    getSock: () => undefined,
    getOwnId: () => '',
    contacts: new Map(),
    lidToPhone: new Map(),
    chats: new Map(),
    onChatEvent: () => {},
    onChatMerge: () => {},
    loadAvatar: async () => {},
    persistChat: () => {},
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })
  cache.enrichChat(chat, '')
  assert.equal(chat.name, 'Design @ Home')
})

test('normalizes device-qualified phone JIDs to the base phone JID', () => {
  assert.equal(normalizePhoneJid('972506212172:0@s.whatsapp.net'), '972506212172@s.whatsapp.net')
  assert.equal(normalizePhoneJid('972506212172:12'), '972506212172@s.whatsapp.net')
  assert.equal(normalizePhoneJid('972506212172@s.whatsapp.net'), '972506212172@s.whatsapp.net')
})

test('prefers a saved contact name and falls back to the WhatsApp profile name', () => {
  assert.equal(contactName({ name: 'Saved Alice', notify: 'WhatsApp Alice' }), 'Saved Alice')
  assert.equal(contactName({ notify: 'WhatsApp Alice' }), 'WhatsApp Alice')
  assert.equal(whatsappName({ username: 'alice' }), 'alice')
})

test('restored device-qualified chat is merged into its base phone chat', async () => {
  const deviceJid = '972506212172:0@s.whatsapp.net'
  const phoneJid = '972506212172@s.whatsapp.net'
  const chats = new Map()
  const removed: string[] = []
  const chat = {
    jid: deviceJid,
    displayJid: '9725062121720',
    phoneNumber: deviceJid,
    name: 'Ilan Solomon',
    lastMessage: 'hello',
    timestamp: 10,
    unread: 0,
    avatarUrl: '',
    isGroup: false,
    isMuted: true,
    isArchived: true
  }
  const redis = {
    hgetall: async (key: string) => key === 'chats' ? { [deviceJid]: JSON.stringify(chat) } : {},
    hdel: async () => 0,
    zrevrange: async () => [deviceJid],
    hmget: async () => [JSON.stringify(chat)],
    zrange: async () => [deviceJid],
    hkeys: async () => [deviceJid],
    multi: () => ({ hdel() { return this }, zrem() { return this }, exec: async () => [] })
  }
  const cache = new ContactCache({
    redis,
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: jid => jid,
    groupMetadataCacheMs: 1000,
    getSock: () => undefined,
    getOwnId: () => '',
    contacts: new Map(),
    lidToPhone: new Map(),
    chats,
    onChatEvent: () => {},
    onChatMerge: fromJid => removed.push(fromJid),
    loadAvatar: async () => {},
    persistChat: () => {},
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })

  await cache.restoreUiCache()

  assert.equal(chats.has(deviceJid), false)
  assert.equal(chats.get(phoneJid)?.name, 'Ilan Solomon')
  assert.equal(chats.get(phoneJid)?.isMuted, true)
  assert.equal(chats.get(phoneJid)?.isArchived, true)
  assert.deepEqual(removed, [deviceJid])
})

test('call events from another device are routed to the remote caller', async () => {
  const ownLid = '123456789012345@lid'
  const remoteLid = '987654321098765@lid'
  const remotePhone = '972546713955@s.whatsapp.net'
  const cache = new ContactCache({
    redis: {},
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: jid => jid,
    groupMetadataCacheMs: 1000,
    getSock: () => ({ user: { id: '972500000000:1@s.whatsapp.net', lid: ownLid } }),
    getOwnId: () => '972500000000:1@s.whatsapp.net',
    contacts: new Map(),
    lidToPhone: new Map([[remoteLid, remotePhone]]),
    chats: new Map(),
    onChatEvent: () => {},
    onChatMerge: () => {},
    loadAvatar: async () => {},
    persistChat: () => {},
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })

  assert.equal(await cache.callRemoteJid({
    chatId: ownLid,
    from: remoteLid,
    callerPn: remotePhone,
    status: 'accept'
  }), remotePhone)
})

test('does not wipe the saved name when a later sync carries only the WhatsApp profile name', () => {
  const phone = '972548018400@s.whatsapp.net'
  const lid = '199137128540258@lid'
  const contacts = new Map<string, any>()
  const written: Record<string, any> = {}
  const redis: any = {
    hset: async () => {},
    multi: () => ({
      hset: (key: string, id: string, value: string) => { written[id] = value },
      hdel: () => {},
      exec: async () => []
    })
  }
  const cache = new ContactCache({
    redis,
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: jid => jid,
    groupMetadataCacheMs: 1000,
    getSock: () => undefined,
    getOwnId: () => '',
    contacts,
    lidToPhone: new Map(),
    chats: new Map(),
    onChatEvent: () => {},
    onChatMerge: () => {},
    loadAvatar: async () => {},
    persistChat: () => {},
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })

  // First: an address-book entry with a real name.
  cache.rememberContact({ id: phone, phoneNumber: phone, name: 'חיים ישראלי' })
  assert.equal(contacts.get(phone)?.name, 'חיים ישראלי')

  // Then: a WhatsApp-only sync arrives with ONLY the profile username (no name).
  // Old code used to clobber the stored name here — the whole reason old users
  // lose their names. It must be preserved.
  cache.rememberContact({ id: lid, lid, phoneNumber: phone, notify: 'HaimY' })
  assert.equal(contacts.get(phone)?.name, 'חיים ישראלי')
  assert.equal(contacts.get(phone)?.notify, 'HaimY')
  assert.equal(contactName(contacts.get(phone)!), 'חיים ישראלי')
})

test('prefers a named contact over a non-mapped LID contact when the LID version is unnamed', () => {
  const lid = '987654321098765@lid'
  const phone = '972546713955@s.whatsapp.net'
  const namedContact = { id: phone, name: 'Alice' }
  const cache = new ContactCache({
    redis: {},
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: jid => jid,
    groupMetadataCacheMs: 1000,
    getSock: () => undefined,
    getOwnId: () => '',
    contacts: new Map([[lid, { id: lid }], [phone, namedContact]]),
    lidToPhone: new Map([[lid, phone]]),
    chats: new Map(),
    onChatEvent: () => {},
    onChatMerge: () => {},
    loadAvatar: async () => {},
    persistChat: () => {},
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })

  assert.equal(cache.contactForJid(lid)?.name, 'Alice')
})

test('rememberGroupParticipants does nothing before the socket is connected (the startup-order guard)', async () => {
  let redisSetCalls = 0
  const jid = '9725000000000-999@g.us'
  const cache = new ContactCache({
    redis: { set: async () => { redisSetCalls++ } },
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: value => value,
    groupMetadataCacheMs: 1000,
    getSock: () => undefined, // no connected socket yet (before startSock)
    getOwnId: () => '',
    contacts: new Map(),
    lidToPhone: new Map(),
    chats: new Map(),
    onChatEvent: () => {},
    onChatMerge: () => {},
    loadAvatar: async () => {},
    persistChat: () => {},
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })
  // This mirrors the call sites made from init() before startSock(): it must be a
  // safe no-op (redis.set throttling the metadata fetch must not even be touched),
  // which is why the actual refresh is deferred to the connection 'open' handler.
  await cache.rememberGroupParticipants(jid)
  assert.equal(redisSetCalls, 0, 'no connected socket -> no metadata fetch attempt')
})

test('clears and emits stale typing presence when no stop event arrives', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const jid = '972501234567@s.whatsapp.net'
  const chat: any = {
    jid,
    displayJid: '972501234567',
    phoneNumber: jid,
    name: 'Contact',
    lastMessage: 'hello',
    timestamp: 10,
    unread: 0,
    avatarUrl: '',
    isGroup: false
  }
  const emitted: any[] = []
  const cache = new ContactCache({
    redis: {},
    label: 'test',
    contactCacheKey: 'contacts',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    groupMetadataCacheKey: value => value,
    groupMetadataCacheMs: 1000,
    getSock: () => undefined,
    getOwnId: () => '',
    contacts: new Map(),
    lidToPhone: new Map(),
    chats: new Map([[jid, chat]]),
    onChatEvent: value => emitted.push({ ...value }),
    onChatMerge: () => {},
    loadAvatar: async () => {},
    persistChat: () => {},
    trimChatCache: () => {},
    removeChatStore: async () => {},
    removeMessageStore: async () => {},
    removeNonChat: () => {},
    restoreMessages: async () => {}
  })

  cache.processPresenceData(chat, { [jid]: { lastKnownPresence: 'composing' } })
  assert.equal(chat.typing, 'typing')

  context.mock.timers.tick(10_000)

  assert.equal(chat.typing, null)
  assert.equal(chat.typingTimestamp, undefined)
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1].typing, null)
})
