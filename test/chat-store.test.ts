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
