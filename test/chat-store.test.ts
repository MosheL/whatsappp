import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatStore } from '../src/chat-store.ts'

test('persists and emits archive changes received from WhatsApp', () => {
  const jid = '972501234567@s.whatsapp.net'
  const chats = new Map()
  const persisted: any[] = []
  const emitted: any[] = []
  const redis = {
    multi: () => ({
      hset(_key: string, _jid: string, value: string) {
        persisted.push(JSON.parse(value))
        return this
      },
      zadd() { return this },
      zremrangebyrank() { return this },
      exec: async () => []
    })
  }
  const store = new ChatStore({
    redis,
    label: 'test',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    messagePayloadKey: () => '',
    chatSettingsSyncKey: 'chat-settings-sync',
    CHAT_LIMIT: 500,
    CHAT_SETTINGS_RESYNC_INTERVAL_MS: 1000,
    canonicalJid: value => value,
    isOwnReceipt: () => false,
    chats,
    listChats: () => [...chats.values()],
    sock: { current: null },
    onChatEvent: chat => emitted.push({ ...chat })
  })

  store.upsertChatFromBaileys({ id: jid, archived: true })
  assert.equal(chats.get(jid)?.isArchived, true)

  store.upsertChatFromBaileys({ id: jid, archived: false })
  assert.equal(chats.get(jid)?.isArchived, false)
  assert.deepEqual(persisted.map(chat => chat.isArchived), [true, false])
  assert.deepEqual(emitted.map(chat => chat.isArchived), [true, false])
})

test('keeps the latest message status and receipts on the chat preview', () => {
  const jid = 'group@g.us'
  const chats = new Map([[jid, {
    jid,
    displayJid: jid,
    phoneNumber: '',
    name: 'Group',
    lastMessage: 'hello',
    timestamp: 1,
    unread: 0,
    avatarUrl: '',
    isGroup: true
  }]])
  const store = new ChatStore({
    redis: { multi: () => ({ hset() { return this }, zadd() { return this }, zremrangebyrank() { return this }, exec: async () => [] }) },
    label: 'test',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    messagePayloadKey: () => '',
    chatSettingsSyncKey: 'chat-settings-sync',
    CHAT_LIMIT: 500,
    CHAT_SETTINGS_RESYNC_INTERVAL_MS: 1000,
    canonicalJid: value => value,
    isOwnReceipt: () => false,
    chats,
    listChats: () => [...chats.values()],
    sock: { current: null },
    onChatEvent: () => {}
  })
  const receipt: any = { userJid: 'one', readTimestamp: 2 }

  store.updateChatFromEditedMessage(jid, {
    id: 'message',
    jid,
    key: { id: 'message', remoteJid: jid },
    fromMe: true,
    sender: 'me',
    text: 'hello',
    type: 'conversation',
    timestamp: 2,
    status: 4,
    receipt,
    userReceipt: [receipt]
  })

  assert.equal(chats.get(jid)?.lastMessageStatus, 4)
  assert.deepEqual(chats.get(jid)?.lastMessageReceipt, receipt)
  assert.deepEqual(chats.get(jid)?.lastMessageUserReceipt, [receipt])
})

test('interactive (cta_url) messages without text pop the chat to the top of the list', () => {
  const jid = '972501234567@s.whatsapp.net'
  const chats = new Map([[jid, {
    jid,
    displayJid: jid,
    phoneNumber: '',
    name: 'Driver',
    lastMessage: 'older message',
    timestamp: 100,
    unread: 0,
    avatarUrl: '',
    isGroup: false
  }]])
  const emitted: any[] = []
  const redis = {
    multi: () => ({
      hset() { return this },
      zadd() { return this },
      zremrangebyrank() { return this },
      exec: async () => []
    })
  }
  const store = new ChatStore({
    redis,
    label: 'test',
    chatCacheKey: 'chats',
    chatIndexKey: 'chat-index',
    messagePayloadKey: () => '',
    chatSettingsSyncKey: 'chat-settings-sync',
    CHAT_LIMIT: 500,
    CHAT_SETTINGS_RESYNC_INTERVAL_MS: 1000,
    canonicalJid: value => value,
    isOwnReceipt: () => false,
    chats,
    listChats: () => [...chats.values()],
    sock: { current: null },
    onChatEvent: chat => emitted.push({ ...chat })
  })

  // A cta_url interactive message with no body/header text — only a button.
  // Before the fix this was treated as non-displayable, so the chat timestamp
  // was not advanced and the chat stayed put in the list.
  store.updateChatFromEditedMessage(jid, {
    id: 'cta',
    jid,
    key: { id: 'cta', remoteJid: jid },
    fromMe: false,
    sender: 'Bot',
    text: '',
    type: 'interactiveMessage',
    timestamp: 200,
    interactiveData: {
      type: 'interactive',
      body: '',
      title: '',
      footer: 'סדרן: משה',
      buttons: [{ text: 'ניווט ליעד', type: 'url', url: 'https://waze.com/ul?ll=32,34', name: 'cta_url' }]
    }
  })

  const chat = chats.get(jid)
  assert.equal(chat?.timestamp, 200, 'chat timestamp advances so the chat pops to the top')
  assert.equal(chat?.lastMessage, 'הודעה אינטראקטיבית', 'preview falls back to an interactive label, not the raw type')
})
