import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bot } from '../src/bot.ts'

type AnyCall = { mod: any; jid: string }

function makeFakeClearBot() {
  const events: Array<{ type: string; payload: any }> = []
  const chatModifyCalls: AnyCall[] = []
  const removedChats: string[] = []
  const removedMessages: string[] = []
  const clearedMedia: string[] = []
  let chatModifyHook: (mod: any, jid: string) => void = (mod, jid) => {
    chatModifyCalls.push({ mod, jid })
  }

  const chats = new Map<string, any>()
  const baseChat = {
    jid: 'group@g.us',
    name: 'Group',
    lastMessage: 'hello',
    lastMessageId: 'm1',
    lastMessageFromMe: false,
    lastMessageStatus: 3,
    lastMessageReceipt: { x: 1 },
    unread: 3,
    isArchived: true,
    isGroup: true,
    timestamp: 1000
  }
  chats.set('group@g.us', { ...baseChat })
  chats.set('other@g.us', { ...baseChat, jid: 'other@g.us', name: 'Other' })

  const messages = new Map<string, any[]>([[
    'group@g.us',
    [{ id: 'm1', jid: 'group@g.us'.replace('g.us', 'g.us'), fromMe: false, key: { participant: 'p1@s.whatsapp.net' }, timestamp: 1000 }]
  ]])

  const fakeBot: any = {
    authKey: 'bot1',
    chats,
    messages,
    sock: {
      chatModify: async (mod: any, jid: string) => { chatModifyHook(mod, jid) }
    },
    contactCache: { canonicalJid: (jid: string) => jid },
    events: { emit: (type: string, payload: any) => events.push({ type, payload }) },
    persistChat: () => {},
    listChats: () => [...chats.values()],
    removeChatStore: async (jid: string) => { removedChats.push(jid); chats.delete(jid) },
    messageStore: {
      getStoredMessages: async () => ([{ id: 'm1', fromMe: false, key: { participant: 'p1@s.whatsapp.net' } }]),
      removeMessageStore: async (jid: string) => { removedMessages.push(jid) },
      clearMediaStore: async (jid: string) => { clearedMedia.push(jid) }
    }
  }

  fakeBot.lastMessagesForChat = Bot.prototype.lastMessagesForChat
  fakeBot.clearLocalChatContent = Bot.prototype.clearLocalChatContent
  fakeBot.clearChat = Bot.prototype.clearChat
  fakeBot.deleteChat = Bot.prototype.deleteChat
  fakeBot.clearArchivedChats = Bot.prototype.clearArchivedChats

  return {
    fakeBot,
    events,
    chatModifyCalls,
    removedChats,
    removedMessages,
    clearedMedia,
    chats,
    setChatModify: (fn: (mod: any, jid: string) => void) => { chatModifyHook = fn }
  }
}

test('clearChat with both scope clears remote phone and local store', async () => {
  const { fakeBot, chatModifyCalls, events, removedMessages, clearedMedia, chats } = makeFakeClearBot()

  const result = await Bot.prototype.clearChat.call(fakeBot, 'group@g.us', 'both')

  assert.deepEqual(result, { ok: true, jid: 'group@g.us', scope: 'both' })
  assert.equal(chatModifyCalls.length, 1)
  assert.equal(chatModifyCalls[0].mod.clear, true)
  assert.equal(chatModifyCalls[0].jid, 'group@g.us')
  assert.ok(Array.isArray(chatModifyCalls[0].mod.lastMessages))
  const chat = chats.get('group@g.us')
  assert.equal(chat.lastMessage, '')
  assert.equal(chat.unread, 0)
  assert.deepEqual(removedMessages, ['group@g.us'])
  assert.deepEqual(clearedMedia, ['group@g.us'])
  assert.ok(events.some(event => event.payload.type === 'chat-cleared'))
})

test('clearChat with local scope does not touch the phone', async () => {
  const { fakeBot, chatModifyCalls, removedMessages } = makeFakeClearBot()

  await Bot.prototype.clearChat.call(fakeBot, 'group@g.us', 'local')

  assert.equal(chatModifyCalls.length, 0)
  assert.deepEqual(removedMessages, ['group@g.us'])
})

test('deleteChat with both scope deletes remote chat and local entry', async () => {
  const { fakeBot, chatModifyCalls, events, removedChats, removedMessages, chats } = makeFakeClearBot()

  await Bot.prototype.deleteChat.call(fakeBot, 'group@g.us', 'both')

  assert.equal(chatModifyCalls.length, 1)
  assert.equal(chatModifyCalls[0].mod.delete, true)
  assert.deepEqual(removedMessages, ['group@g.us'])
  assert.deepEqual(removedChats, ['group@g.us'])
  assert.equal(chats.has('group@g.us'), false)
  assert.ok(events.some(event => event.payload.type === 'chat-deleted'))
})

test('clearArchivedChats clears every archived chat', async () => {
  const { fakeBot, chatModifyCalls, removedMessages } = makeFakeClearBot()

  const result = await Bot.prototype.clearArchivedChats.call(fakeBot, { scope: 'both' })

  assert.equal(result.total, 2)
  assert.equal(result.cleared, 2)
  assert.equal(result.failed, 0)
  assert.equal(chatModifyCalls.length, 2)
  assert.deepEqual(removedMessages.sort(), ['group@g.us', 'other@g.us'])
})

test('clearArchivedChats reports failures without aborting the batch', async () => {
  const { fakeBot, setChatModify, chatModifyCalls } = makeFakeClearBot()
  let calls = 0
  setChatModify((mod, jid) => {
    calls++
    if (jid === 'group@g.us') throw new Error('remote failed')
    chatModifyCalls.push({ mod, jid })
  })

  const result = await Bot.prototype.clearArchivedChats.call(fakeBot, { scope: 'both' })

  assert.equal(calls, 2)
  assert.equal(result.total, 2)
  assert.equal(result.cleared, 1)
  assert.equal(result.failed, 1)
})

test('clearArchivedChats can delete archived chats instead of clearing', async () => {
  const { fakeBot, chatModifyCalls, removedChats } = makeFakeClearBot()

  await Bot.prototype.clearArchivedChats.call(fakeBot, { scope: 'both', deleteChats: true })

  assert.equal(chatModifyCalls.length, 2)
  assert.ok(chatModifyCalls.every(call => call.mod.delete === true))
  assert.deepEqual(removedChats.sort(), ['group@g.us', 'other@g.us'])
})