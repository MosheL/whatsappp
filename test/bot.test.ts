import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bot, linkPreviewUrlFromText } from '../src/bot.ts'
import { messageLocation } from '../src/message-processor.ts'

test('marks dragged media as forwarded and preserves audio media kind', async () => {
  let sentContent: any
  const fakeBot: any = {
    sock: {
      sendMessage: async (_jid: string, content: any) => {
        sentContent = content
        return { key: { id: 'sent', remoteJid: 'target@s.whatsapp.net', fromMe: true } }
      }
    },
    contactCache: { resolveOutgoingJid: (jid: string) => jid },
    messageStore: { persistMedia: async () => {} },
    recordUiMessage: (message: any) => message
  }

  const message = await Bot.prototype.sendFile.call(
    fakeBot,
    'target@s.whatsapp.net',
    Buffer.from('audio'),
    'voice.ogg',
    'audio/ogg',
    '',
    true
  )

  assert.deepEqual(sentContent.contextInfo, { forwardingScore: 1, isForwarded: true })
  assert.equal(message.forwarded, true)
  assert.equal(message.media.kind, 'audio')
})

test('keeps answered call updates in the chat resolved from the call offer', async () => {
  const recorded: any[] = []
  const resolved: string[] = []
  const fakeBot: any = {
    callPeers: new Map(),
    contactCache: {
      callRemoteJid: async (call: any) => {
        resolved.push(call.from)
        return call.from
      },
      phoneForJid: () => ''
    },
    chatStore: { callStatusText: (status: string) => status },
    recordUiMessage: (message: any) => recorded.push(message)
  }

  await Bot.prototype.recordCallEvent.call(fakeBot, {
    id: 'call-1',
    from: 'remote@s.whatsapp.net',
    status: 'offer',
    date: new Date(1)
  })
  await Bot.prototype.recordCallEvent.call(fakeBot, {
    id: 'call-1',
    from: 'me@s.whatsapp.net',
    chatId: 'me@s.whatsapp.net',
    status: 'accept',
    date: new Date(2)
  })
  await Bot.prototype.recordCallEvent.call(fakeBot, {
    id: 'call-1',
    from: 'me@s.whatsapp.net',
    status: 'terminate',
    date: new Date(3)
  })

  assert.deepEqual(recorded.map(message => message.jid), [
    'remote@s.whatsapp.net',
    'remote@s.whatsapp.net',
    'remote@s.whatsapp.net'
  ])
  assert.deepEqual(resolved, ['remote@s.whatsapp.net'])
  assert.equal(fakeBot.callPeers.has('call-1'), false)
})

test('sends text only after the link preview result is supplied', async () => {
  let sentContent: any
  const fakeBot: any = {
    sock: {
      sendMessage: async (_jid: string, content: any) => {
        sentContent = content
        return { key: { id: 'sent', remoteJid: 'target@s.whatsapp.net', fromMe: true } }
      }
    },
    label: 'test',
    contactCache: { resolveOutgoingJid: (jid: string) => jid },
    messageStore: { getStoredMessage: async () => undefined, getStoredMessages: async () => [] },
    resolveLinkPreview: async () => undefined,
    recordUiMessage: (message: any) => message
  }

  const message = await Bot.prototype.sendText.call(fakeBot, 'target@s.whatsapp.net', 'plain text')

  assert.equal(sentContent.linkPreview, null)
  assert.equal(message.text, 'plain text')
})

test('normalizes www links only for preview fetching', () => {
  assert.deepEqual(linkPreviewUrlFromText('look www.example.com/page'), {
    matchedText: 'www.example.com/page',
    fetchUrl: 'https://www.example.com/page'
  })
  assert.deepEqual(linkPreviewUrlFromText('look https://example.com/page'), {
    matchedText: 'https://example.com/page',
    fetchUrl: 'https://example.com/page'
  })
})

test('deduplicates LID and phone contacts in the UI contact list', () => {
  const lid = '123456789012345@lid'
  const phone = '972501234567@s.whatsapp.net'
  const contact = { id: lid, name: 'Alice', phoneNumber: phone }
  const fakeBot: any = {
    contacts: new Map([
      [lid, contact],
      [phone, contact]
    ]),
    lidToPhone: new Map([[lid, phone]]),
    chats: new Map(),
    contactCache: {
      phoneForJid: (jid: string, item: any) => item?.phoneNumber || (jid.endsWith('@s.whatsapp.net') ? jid : '')
    }
  }

  assert.deepEqual(Bot.prototype.listContacts.call(fakeBot), [
    { jid: phone, name: 'Alice', phoneNumber: phone }
  ])
})

test('reuses link preview cache entries by URL across different message text', async () => {
  const preview = Promise.resolve({ title: 'Cached preview' })
  const fakeBot: any = {
    linkPreviewCache: new Map([
      ['https://example.com/page', { expiresAt: Date.now() + 120000, promise: preview }]
    ])
  }

  const result = await Bot.prototype.resolveLinkPreview.call(fakeBot, 'different words https://example.com/page')

  assert.equal(result?.title, 'Cached preview')
})

test('requests older messages using the original WhatsApp transport key', async () => {
  const calls: any[] = []
  const fakeBot: any = {
    sock: {
      fetchMessageHistory: async (...args: any[]) => {
        calls.push(args)
        return 'request-1'
      }
    },
    label: 'test',
    contactCache: { resolveOutgoingJid: () => '972501234567@s.whatsapp.net' },
    messageStore: {
      getOldestStoredMessage: async () => ({
        id: 'oldest',
        jid: '972501234567@s.whatsapp.net',
        key: { id: 'oldest', remoteJid: '972501234567@s.whatsapp.net', fromMe: false },
        raw: {
          key: {
            id: 'oldest',
            remoteJid: '123456789012345@lid',
            remoteJidAlt: '972501234567@s.whatsapp.net',
            fromMe: false
          },
          messageTimestamp: 1_700_000_000
        },
        timestamp: 1_700_000_000_000
      }),
      waitForOlderMessages: async () => []
    }
  }

  await Bot.prototype.syncOlderMessages.call(fakeBot, '972501234567@s.whatsapp.net', 50)

  assert.equal(calls[0][1].remoteJid, '123456789012345@lid')
  assert.equal(calls[0][1].remoteJidAlt, '972501234567@s.whatsapp.net')
  assert.equal(calls[0][2], 1_700_000_000_000)
})

test('uses LID participant identifiers for mentions in LID-addressed groups', async () => {
  const lid = '123456789012345@lid'
  const phone = '972501234567@s.whatsapp.net'
  let sentContent: any
  const fakeBot: any = {
    sock: {
      groupMetadata: async () => ({
        addressingMode: 'lid',
        participants: [{ id: lid, lid }]
      }),
      sendMessage: async (_jid: string, content: any) => {
        sentContent = content
        return { key: { id: 'sent', remoteJid: 'group@g.us', fromMe: true } }
      }
    },
    contactCache: {
      resolveOutgoingJid: (jid: string) => jid,
      rememberContact: () => {},
      phoneForJid: () => '',
      resolveLidToPhone: async () => phone,
      contactForJid: () => ({ notify: 'WhatsApp Alice' })
    },
    messageStore: { getStoredMessage: async () => undefined, getStoredMessages: async () => [] },
    resolveLinkPreview: async () => undefined,
    recordUiMessage: (message: any) => message
  }

  const participants = await Bot.prototype.groupParticipants.call(fakeBot, 'group@g.us')
  fakeBot.groupParticipants = () => participants
  await Bot.prototype.sendText.call(fakeBot, 'group@g.us', '@Alice hello', '', '', [lid, phone, 'stranger@lid'])

  assert.deepEqual(participants, [{ jid: lid, name: 'WhatsApp Alice', phoneNumber: phone }])
  assert.deepEqual(sentContent.mentions, [lid])
})

test('uses the WhatsApp push name from stored group messages when contact metadata has no name', async () => {
  const lid = '123456789012345@lid'
  const phone = '972501234567@s.whatsapp.net'
  const fakeBot: any = {
    sock: {
      groupMetadata: async () => ({
        addressingMode: 'lid',
        participants: [{ id: lid, lid }]
      })
    },
    messages: new Map(),
    contactCache: {
      resolveOutgoingJid: (jid: string) => jid,
      rememberContact: () => {},
      phoneForJid: () => phone,
      resolveLidToPhone: async () => phone,
      contactForJid: () => undefined
    },
    messageStore: {
      getStoredMessages: async () => [{
        key: { participant: lid, participantAlt: phone },
        raw: { pushName: 'WhatsApp Alice' },
        sender: 'WhatsApp Alice',
        senderNumber: '972501234567'
      }]
    }
  }

  const participants = await Bot.prototype.groupParticipants.call(fakeBot, 'group@g.us')

  assert.deepEqual(participants, [{ jid: lid, name: 'WhatsApp Alice', phoneNumber: phone }])
})

test('uses a named direct chat for a group participant when contact metadata has no name', async () => {
  const lid = '123456789012345@lid'
  const phone = '972501234567@s.whatsapp.net'
  const fakeBot: any = {
    sock: {
      groupMetadata: async () => ({
        addressingMode: 'lid',
        participants: [{ id: lid, lid }]
      })
    },
    chats: new Map([[phone, {
      jid: phone,
      displayJid: '972501234567',
      phoneNumber: phone,
      name: 'WhatsApp Alice',
      isGroup: false
    }]]),
    contactCache: {
      resolveOutgoingJid: (jid: string) => jid,
      rememberContact: () => {},
      phoneForJid: () => phone,
      resolveLidToPhone: async () => phone,
      contactForJid: () => undefined
    },
    messageStore: { getStoredMessages: async () => [] }
  }

  const participants = await Bot.prototype.groupParticipants.call(fakeBot, 'group@g.us')

  assert.deepEqual(participants, [{ jid: lid, name: 'WhatsApp Alice', phoneNumber: phone }])
})

test('reuses a WhatsApp push name learned from another group', async () => {
  const lid = '123456789012345@lid'
  const phone = '972501234567@s.whatsapp.net'
  const fakeBot: any = {
    sock: {
      groupMetadata: async () => ({
        addressingMode: 'lid',
        participants: [{ id: lid, lid }]
      })
    },
    chats: new Map(),
    messages: new Map([['other-group@g.us', [{
      key: { participant: lid, participantAlt: phone },
      raw: { pushName: 'WhatsApp Alice' },
      sender: 'WhatsApp Alice',
      senderNumber: '972501234567'
    }]]]),
    contactCache: {
      resolveOutgoingJid: (jid: string) => jid,
      rememberContact: () => {},
      phoneForJid: () => phone,
      resolveLidToPhone: async () => phone,
      contactForJid: () => undefined
    },
    messageStore: { getStoredMessages: async () => [] }
  }

  const participants = await Bot.prototype.groupParticipants.call(fakeBot, 'group@g.us')

  assert.deepEqual(participants, [{ jid: lid, name: 'WhatsApp Alice', phoneNumber: phone }])
})

test('reuses a WhatsApp name learned by another bot connection', async () => {
  const lid = '888888888888888@lid'
  const phone = '972509999999@s.whatsapp.net'
  const makeFakeBot = (messages: any[]) => ({
    sock: {
      groupMetadata: async () => ({
        addressingMode: 'lid',
        participants: [{ id: lid, lid }]
      })
    },
    chats: new Map(),
    messages: new Map([['other-group@g.us', messages]]),
    contactCache: {
      resolveOutgoingJid: (jid: string) => jid,
      rememberContact: () => {},
      phoneForJid: () => phone,
      resolveLidToPhone: async () => phone,
      contactForJid: () => undefined
    },
    messageStore: { getStoredMessages: async () => [] }
  })
  const namedBot: any = makeFakeBot([{
    key: { participant: lid, participantAlt: phone },
    raw: { pushName: 'Shared Alice' },
    sender: 'Shared Alice',
    senderNumber: '972509999999'
  }])
  const unknownBot: any = makeFakeBot([])

  await Bot.prototype.groupParticipants.call(namedBot, 'group@g.us')
  const participants = await Bot.prototype.groupParticipants.call(unknownBot, 'group@g.us')

  assert.deepEqual(participants, [{ jid: lid, name: 'Shared Alice', phoneNumber: phone }])
})

test('shares a resolved direct-chat name with another bot connection', async () => {
  const lid = '777777777777777@lid'
  const phone = '972508888888@s.whatsapp.net'
  const makeFakeBot = (chats: Map<string, any>) => ({
    sock: {
      groupMetadata: async () => ({
        addressingMode: 'lid',
        participants: [{ id: lid, lid }]
      })
    },
    chats,
    messages: new Map(),
    contactCache: {
      resolveOutgoingJid: (jid: string) => jid,
      rememberContact: () => {},
      phoneForJid: () => phone,
      resolveLidToPhone: async () => phone,
      contactForJid: () => undefined
    },
    messageStore: { getStoredMessages: async () => [] }
  })
  const namedBot: any = makeFakeBot(new Map([[phone, {
    jid: phone,
    displayJid: '972508888888',
    phoneNumber: phone,
    name: 'Direct Alice',
    isGroup: false
  }]]))
  const unknownBot: any = makeFakeBot(new Map())

  await Bot.prototype.groupParticipants.call(namedBot, 'group@g.us')
  const participants = await Bot.prototype.groupParticipants.call(unknownBot, 'group@g.us')

  assert.deepEqual(participants, [{ jid: lid, name: 'Direct Alice', phoneNumber: phone }])
})

test('reloads and resizes an avatar after its Redis cache is cleared without requiring a chat entry', async () => {
  const jid = '972501234567@s.whatsapp.net'
  const resized = Buffer.from('resized-avatar')
  const writes: any[] = []
  let requestedJid = ''
  let requestedType = ''
  let resizedUrl = ''
  const fakeBot: any = {
    authKey: 'auth',
    chats: new Map(),
    avatarLoads: new Map(),
    avatarFailures: new Map(),
    contactCache: {
      canonicalJid: (value: string) => value,
      contactForJid: () => undefined
    },
    redis: {
      getBuffer: async () => null,
      set: async (...args: any[]) => writes.push(args)
    },
    sock: {
      serverProps: { profilePicPrivacyToken: true },
      profilePictureUrl: async (value: string, type: string) => {
        requestedJid = value
        requestedType = type
        return 'https://pps.whatsapp.net/avatar.jpg'
      }
    },
    queueAvatarLoad: async (task: () => Promise<void>) => await task(),
    fetchAndCacheAvatar: Bot.prototype.fetchAndCacheAvatar,
    withTimeout: async (promise: Promise<any>) => await promise,
    downloadAndResizeAvatar: async (url: string) => {
      resizedUrl = url
      return resized
    }
  }

  await Bot.prototype.loadAvatar.call(fakeBot, jid)

  assert.equal(requestedJid, jid)
  assert.equal(requestedType, 'image')
  assert.equal(fakeBot.sock.serverProps.profilePicPrivacyToken, false)
  assert.equal(resizedUrl, 'https://pps.whatsapp.net/avatar.jpg')
  assert.deepEqual(writes, [[`ui:auth:avatar:${jid}`, resized]])
})

test('uses a known contact avatar URL without waiting for a WhatsApp lookup', async () => {
  const jid = '972547363663@s.whatsapp.net'
  const sourceUrl = 'https://media-mrs2-3.cdn.whatsapp.net/avatar.jpg'
  let lookups = 0
  let resizedUrl = ''
  const fakeBot: any = {
    label: 'test',
    sock: {
      profilePictureUrl: async () => {
        lookups += 1
        throw new Error('Timed Out')
      }
    },
    avatarFailures: new Map(),
    contactCache: { contactForJid: () => ({ imgUrl: sourceUrl }) },
    withTimeout: async (promise: Promise<any>) => await promise,
    isAvatarNotFoundError: Bot.prototype.isAvatarNotFoundError,
    downloadAndResizeAvatar: async (url: string) => {
      resizedUrl = url
      return Buffer.from('resized-avatar')
    },
    redis: { set: async () => {} }
  }

  await Bot.prototype.fetchAndCacheAvatar.call(fakeBot, jid, `avatar:${jid}`)

  assert.equal(lookups, 0)
  assert.equal(resizedUrl, sourceUrl)
})

test('deduplicates concurrent avatar loads for the same contact', async () => {
  const jid = '972501234567@s.whatsapp.net'
  let fetches = 0
  const fakeBot: any = {
    authKey: 'auth',
    sock: {},
    avatarLoads: new Map(),
    avatarFailures: new Map(),
    contactCache: { canonicalJid: (value: string) => value },
    redis: { getBuffer: async () => null },
    queueAvatarLoad: async (task: () => Promise<void>) => await task(),
    fetchAndCacheAvatar: async () => {
      fetches += 1
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  await Promise.all([
    Bot.prototype.loadAvatar.call(fakeBot, jid),
    Bot.prototype.loadAvatar.call(fakeBot, jid),
    Bot.prototype.loadAvatar.call(fakeBot, jid)
  ])

  assert.equal(fetches, 1)
})

test('limits concurrent WhatsApp avatar lookups to two', async () => {
  const fakeBot: any = { avatarActive: 0, avatarQueue: [] }
  let active = 0
  let maximum = 0
  const task = () => Bot.prototype.queueAvatarLoad.call(fakeBot, async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active -= 1
  })

  await Promise.all([task(), task(), task(), task(), task()])

  assert.equal(maximum, 2)
})

test('stops after a definitive missing-avatar response and caches the miss', async () => {
  const jid = '120363182207761185@g.us'
  const requestedTypes: string[] = []
  const failures = new Map<string, number>()
  const fakeBot: any = {
    label: 'test',
    sock: {
      profilePictureUrl: async (_jid: string, type: string) => {
        requestedTypes.push(type)
        throw new Error('item-not-found')
      }
    },
    avatarFailures: failures,
    contactCache: { contactForJid: () => undefined },
    withTimeout: async (promise: Promise<any>) => await promise,
    isAvatarNotFoundError: Bot.prototype.isAvatarNotFoundError,
    downloadAndResizeAvatar: async () => undefined,
    redis: { set: async () => {} }
  }

  await Bot.prototype.fetchAndCacheAvatar.call(fakeBot, jid, `avatar:${jid}`)

  assert.deepEqual(requestedTypes, ['image'])
  assert.ok((failures.get(jid) || 0) > Date.now() + 23 * 60 * 60 * 1000)
})

test('resolves actual mentions with server names without replacing emails', () => {
  const phone = '972501234567@s.whatsapp.net'
  const recorded: any[] = []
  const fakeBot: any = {
    contactCache: {
      isOwnMessage: () => false,
      messageRemoteJid: () => 'group@g.us',
      canonicalJid: (jid: string) => jid,
      senderDisplayName: ({ participant }: any) => participant === phone ? 'Alice' : 'Sender',
      isOwnJid: () => false,
      participantPhone: () => '972509999999'
    },
    reactionMessagePatch: () => undefined,
    deletedMessagePatch: () => undefined,
    editedMessagePatch: () => undefined,
    secretEncryptedMessagePatch: () => undefined,
    recordUiMessage: (message: any) => recorded.push(message),
    quotedFromIncomingMessage: () => undefined
  }

  Bot.prototype.recordBaileysMessage.call(fakeBot, {
    key: { id: 'message-1', remoteJid: 'group@g.us', participant: '972509999999@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: 'email me at a@example.com, then ask @972501234567.',
        contextInfo: { mentionedJid: [phone] }
      }
    },
    messageTimestamp: 1
  })

  assert.equal(recorded[0].text, 'email me at a@example.com, then ask @[972501234567|Alice].')
})

test('purges all in-memory account data on unlink', async () => {
  const cleared: string[] = []
  const clearable = (name: string) => new Map([['value', name]]) as any
  for (const name of ['chats', 'messages', 'contacts', 'lidToPhone', 'healedGroups', 'pendingChatSettings', 'transcriptionCache', 'linkPreviewCache', 'callPeers', 'avatarLoads', 'avatarFailures']) {
    const map = clearable(name)
    const clear = map.clear.bind(map)
    map.clear = () => {
      cleared.push(name)
      clear()
    }
    ;(clearable as any)[name] = map
  }
  const patterns: string[] = []
  const fakeBot: any = {
    authKey: 'auth',
    redis: {
      scan: async () => ['0', []],
      del: async () => 0,
      unlink: async () => 0
    },
    ...Object.fromEntries(['chats', 'messages', 'contacts', 'lidToPhone', 'healedGroups', 'pendingChatSettings', 'transcriptionCache', 'linkPreviewCache', 'callPeers', 'avatarLoads', 'avatarFailures'].map(name => [name, (clearable as any)[name]])),
    avatarQueue: [() => {}],
    avatarActive: 2,
    state: { creds: { oldAccountValue: true } },
    events: { emit: () => {} },
    id: 'account',
    qr: 'qr'
  }

  await Bot.prototype.purgeAccountData.call(fakeBot)

  assert.equal(cleared.length, 11)
  assert.deepEqual(fakeBot.avatarQueue, [])
  assert.equal(fakeBot.avatarActive, 0)
  assert.equal(fakeBot.id, '')
  assert.equal(fakeBot.qr, '')
  assert.equal(fakeBot.state.creds.oldAccountValue, undefined)
  assert.ok(fakeBot.state.creds.noiseKey)
})

test('extracts location data when recording a locationMessage via recordBaileysMessage', () => {
  const recorded: any[] = []
  const fakeBot: any = {
    sock: { presenceSubscribe: async () => {} },
    authKey: 'auth',
    contactCache: {
      canonicalJid: (jid: string) => jid,
      senderDisplayName: () => 'Sender',
      participantPhone: () => '',
      isOwnJid: () => false,
      isOwnMessage: () => false,
      messageRemoteJid: (msg: any) => msg.key.remoteJid,
      ensureChatMeta: async () => ({ jid: 'user@s.whatsapp.net', timestamp: 0, lastSeen: 0 } as any)
    },
    messageStore: {
      get: () => [],
      set: () => {},
      persistMedia: async () => {}
    },
    events: { emit: () => {} },
    chatStore: { callStatusText: (s: string) => s, persistChat: () => {} },
    trimChatCache: () => {},
    messages: new Map(),
    chats: new Map(),
    callPeers: new Map(),
    reactionMessagePatch: () => undefined,
    deletedMessagePatch: () => undefined,
    editedMessagePatch: () => undefined,
    secretEncryptedMessagePatch: () => undefined,
    recordUiMessage: (message: any) => recorded.push(message),
    quotedFromIncomingMessage: () => undefined
  }

  Bot.prototype.recordBaileysMessage.call(fakeBot, {
    key: { id: 'loc-msg-1', remoteJid: 'user@s.whatsapp.net' },
    message: {
      locationMessage: {
        degreesLatitude: 32.0853,
        degreesLongitude: 34.7818,
        name: 'Azrieli Center',
        address: 'Tel Aviv'
      }
    },
    messageTimestamp: 1700000000
  })

  assert.equal(recorded.length, 1)
  const msg = recorded[0]
  assert.equal(msg.type, 'locationMessage')
  assert.ok(msg.location)
  assert.equal(msg.location.latitude, 32.0853)
  assert.equal(msg.location.longitude, 34.7818)
  assert.equal(msg.location.name, 'Azrieli Center')
  assert.equal(msg.location.address, 'Tel Aviv')
  // Verify the same location is extracted by messageLocation directly
  const extracted = messageLocation({
    locationMessage: {
      degreesLatitude: 32.0853,
      degreesLongitude: 34.7818,
      name: 'Azrieli Center',
      address: 'Tel Aviv'
    }
  })
  assert.deepEqual(extracted, msg.location)
})

test('records a liveLocationMessage with comment and URL', () => {
  const recorded: any[] = []
  const fakeBot: any = {
    sock: { presenceSubscribe: async () => {} },
    authKey: 'auth',
    contactCache: {
      canonicalJid: (jid: string) => jid,
      senderDisplayName: () => 'Sender',
      participantPhone: () => '',
      isOwnJid: () => false,
      isOwnMessage: () => false,
      messageRemoteJid: (msg: any) => msg.key.remoteJid,
      ensureChatMeta: async () => ({ jid: 'user@s.whatsapp.net', timestamp: 0, lastSeen: 0 } as any)
    },
    messageStore: {
      get: () => [],
      set: () => {},
      persistMedia: async () => {}
    },
    events: { emit: () => {} },
    chatStore: { callStatusText: (s: string) => s, persistChat: () => {} },
    trimChatCache: () => {},
    messages: new Map(),
    chats: new Map(),
    callPeers: new Map(),
    reactionMessagePatch: () => undefined,
    deletedMessagePatch: () => undefined,
    editedMessagePatch: () => undefined,
    secretEncryptedMessagePatch: () => undefined,
    recordUiMessage: (message: any) => recorded.push(message),
    quotedFromIncomingMessage: () => undefined
  }

  Bot.prototype.recordBaileysMessage.call(fakeBot, {
    key: { id: 'live-loc-1', remoteJid: 'user@s.whatsapp.net' },
    message: {
      locationMessage: {
        degreesLatitude: 31.0461,
        degreesLongitude: 34.8516,
        name: 'Beer Sheva',
        isLive: true,
        comment: 'I am here!',
        url: 'https://maps.example.com/live'
      }
    },
    messageTimestamp: 1700000001
  })

  assert.equal(recorded.length, 1)
  const msg = recorded[0]
  assert.equal(msg.type, 'locationMessage')
  assert.ok(msg.location)
  assert.equal(msg.location.isLive, true)
  assert.equal(msg.location.comment, 'I am here!')
  assert.equal(msg.location.url, 'https://maps.example.com/live')
})

test('does not extract location for non-location messages', () => {
  const recorded: any[] = []
  const fakeBot: any = {
    sock: { presenceSubscribe: async () => {} },
    authKey: 'auth',
    contactCache: {
      canonicalJid: (jid: string) => jid,
      senderDisplayName: () => 'Sender',
      participantPhone: () => '',
      isOwnJid: () => false,
      isOwnMessage: () => false,
      messageRemoteJid: (msg: any) => msg.key.remoteJid,
      ensureChatMeta: async () => ({ jid: 'user@s.whatsapp.net', timestamp: 0, lastSeen: 0 } as any)
    },
    messageStore: {
      get: () => [],
      set: () => {},
      persistMedia: async () => {}
    },
    events: { emit: () => {} },
    chatStore: { callStatusText: (s: string) => s, persistChat: () => {} },
    trimChatCache: () => {},
    messages: new Map(),
    chats: new Map(),
    callPeers: new Map(),
    reactionMessagePatch: () => undefined,
    deletedMessagePatch: () => undefined,
    editedMessagePatch: () => undefined,
    secretEncryptedMessagePatch: () => undefined,
    recordUiMessage: (message: any) => recorded.push(message),
    quotedFromIncomingMessage: () => undefined
  }

  Bot.prototype.recordBaileysMessage.call(fakeBot, {
    key: { id: 'text-1', remoteJid: 'user@s.whatsapp.net' },
    message: { conversation: 'hello' },
    messageTimestamp: 1700000002
  })

  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].location, undefined)
})

test('searchMessages returns matching messages across chats enriched with chat names', async () => {
  const jid = '972501234567@s.whatsapp.net'
  const groupJid = 'group@g.us'
  const payloads = {
    [`${jid}:m1`]: JSON.stringify({ id: 'm1', jid, text: 'hello world', sender: 'Alice', fromMe: false, timestamp: 1000, type: 'conversation' }),
    [`${jid}:m2`]: JSON.stringify({ id: 'm2', jid, text: 'no match here', sender: 'Alice', fromMe: false, timestamp: 2000, type: 'conversation' }),
    [`${groupJid}:m3`]: JSON.stringify({ id: 'm3', jid: groupJid, text: 'WORLD greetings', sender: 'Bob', fromMe: true, timestamp: 3000, type: 'conversation' })
  }
  const messageIndex: Record<string, string[]> = {
    [jid]: ['m1', 'm2'],
    [groupJid]: ['m3']
  }
  const fakeBot: any = {
    chatIndexKey: 'ui:auth:chat-index',
    chatCacheKey: 'ui:auth:chats',
    messageIndexKey: (j: string) => `ui:auth:message-index:${j}`,
    messagePayloadKey: (j: string, id: string) => `ui:auth:message:${Buffer.from(`${j}:${id}`).toString('base64url')}`,
    contactCache: { canonicalJid: (value: string) => value },
    messageStore: {
      loadMessagePayloads: async (j: string, ids: string[]) => ids.map(id => payloads[`${j}:${id}`] || null)
    },
    publicMessage: (message: any) => message,
    redis: {
      zrevrange: async (key: string, from: number, to: number) => {
        if (key === 'ui:auth:chat-index') return [groupJid, jid]
        const j = key.replace('ui:auth:message-index:', '')
        return messageIndex[j] || []
      },
      hmget: async (_key: string, ...ids: string[]) => ids.map(id => JSON.stringify({ name: id === jid ? 'Alice' : 'Group', displayJid: id.replace(/@.*/, ''), isGroup: id === groupJid }))
    }
  }

  const { results, truncated } = await Bot.prototype.searchMessages.call(fakeBot, 'world', {})

  assert.equal(truncated, false)
  assert.equal(results.length, 2)
  // newest first
  assert.equal(results[0].id, 'm3')
  assert.equal(results[0].chatName, 'Group')
  assert.equal(results[0].isGroup, true)
  assert.equal(results[0].fromMe, true)
  assert.equal(results[1].id, 'm1')
  assert.equal(results[1].chatName, 'Alice')
})

test('searchMessages is case-insensitive and empty query returns nothing', async () => {
  const jid = '972501234567@s.whatsapp.net'
  const payloads = {
    [`${jid}:m1`]: JSON.stringify({ id: 'm1', jid, text: 'Hello WORLD', sender: 'A', fromMe: false, timestamp: 1, type: 'conversation' })
  }
  const fakeBot: any = {
    chatIndexKey: 'idx',
    chatCacheKey: 'chats',
    messageIndexKey: (j: string) => `idx:${j}`,
    messagePayloadKey: (j: string, id: string) => `${j}:${id}`,
    contactCache: { canonicalJid: (value: string) => value },
    messageStore: { loadMessagePayloads: async (j: string, ids: string[]) => ids.map(id => payloads[`${j}:${id}`] || null) },
    publicMessage: (message: any) => message,
    redis: {
      zrevrange: async (key: string) => key === 'idx' ? [jid] : ['m1'],
      hmget: async () => [JSON.stringify({ name: 'A' })]
    }
  }

  const empty = await Bot.prototype.searchMessages.call(fakeBot, '   ', {})
  assert.deepEqual(empty.results, [])

  const result = await Bot.prototype.searchMessages.call(fakeBot, 'HELLO', {})
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].id, 'm1')
})

test('searchMessages limits to a single chat when chatJid is given', async () => {
  const jid = '972501234567@s.whatsapp.net'
  const other = '972509999999@s.whatsapp.net'
  const payloads = {
    [`${jid}:m1`]: JSON.stringify({ id: 'm1', jid, text: 'find me', sender: 'A', fromMe: false, timestamp: 1, type: 'conversation' }),
    [`${other}:m2`]: JSON.stringify({ id: 'm2', jid: other, text: 'find me too', sender: 'B', fromMe: false, timestamp: 2, type: 'conversation' })
  }
  const fakeBot: any = {
    chatIndexKey: 'idx',
    chatCacheKey: 'chats',
    messageIndexKey: (j: string) => `idx:${j}`,
    messagePayloadKey: (j: string, id: string) => `${j}:${id}`,
    contactCache: { canonicalJid: (value: string) => value },
    messageStore: { loadMessagePayloads: async (j: string, ids: string[]) => ids.map(id => payloads[`${j}:${id}`] || null) },
    publicMessage: (message: any) => message,
    redis: {
      zrevrange: async (key: string) => key === 'idx' ? [other, jid] : ['m1'],
      hmget: async () => [JSON.stringify({ name: 'A' })]
    }
  }

  const { results } = await Bot.prototype.searchMessages.call(fakeBot, 'find', { chatJid: jid })
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'm1')
})

test('getMessagesAround returns the anchor and context on each side', async () => {
  const jid = '972501234567@s.whatsapp.net'
  const ids = ['old', 'anchor', 'new']
  const payloads = {
    old: JSON.stringify({ id: 'old', jid, text: 'old', sender: 'A', fromMe: false, timestamp: 100, type: 'conversation' }),
    anchor: JSON.stringify({ id: 'anchor', jid, text: 'anchor', sender: 'A', fromMe: false, timestamp: 200, type: 'conversation' }),
    new: JSON.stringify({ id: 'new', jid, text: 'new', sender: 'A', fromMe: false, timestamp: 300, type: 'conversation' })
  }
  const fakeBot: any = {
    messageIndexKey: (j: string) => `idx:${j}`,
    contactCache: { canonicalJid: (value: string) => value },
    messageStore: {
      getStoredMessage: async () => JSON.parse(payloads.anchor),
      loadMessagePayloads: async (_j: string, returnedIds: string[]) => returnedIds.map(id => payloads[id] || null)
    },
    publicMessage: (message: any) => message,
    redis: {
      zrevrangebyscore: async () => ['old'],
      zrangebyscore: async () => ['new'],
      zcount: async () => 1
    }
  }

  const result = await Bot.prototype.getMessagesAround.call(fakeBot, jid, 'anchor', 40)

  assert.deepEqual(result.messages.map(m => m.id), ['old', 'anchor', 'new'])
  assert.equal(result.hasOlder, false)
  assert.equal(result.hasNewer, false)
})

test('getMessagesAround reports more context available via hasOlder/hasNewer', async () => {
  const jid = '972501234567@s.whatsapp.net'
  const payloads = {
    anchor: JSON.stringify({ id: 'anchor', jid, text: 'a', sender: 'A', fromMe: false, timestamp: 200, type: 'conversation' })
  }
  const fakeBot: any = {
    messageIndexKey: (j: string) => `idx:${j}`,
    contactCache: { canonicalJid: (value: string) => value },
    messageStore: {
      getStoredMessage: async () => JSON.parse(payloads.anchor),
      loadMessagePayloads: async (_j: string, ids: string[]) => ids.map(id => payloads[id] || null)
    },
    publicMessage: (message: any) => message,
    redis: {
      zrevrangebyscore: async () => [],
      zrangebyscore: async () => [],
      zcount: async () => 30
    }
  }

  const result = await Bot.prototype.getMessagesAround.call(fakeBot, jid, 'anchor', 40)

  assert.equal(result.messages.length, 1)
  assert.equal(result.hasOlder, true)
  assert.equal(result.hasNewer, true)
})

test('getMessagesAround returns empty when the anchor is missing', async () => {
  const fakeBot: any = {
    messageIndexKey: (j: string) => `idx:${j}`,
    contactCache: { canonicalJid: (value: string) => value },
    messageStore: { getStoredMessage: async () => undefined }
  }

  const result = await Bot.prototype.getMessagesAround.call(fakeBot, 'jid', 'missing', 40)
  assert.deepEqual(result.messages, [])
  assert.equal(result.hasOlder, false)
  assert.equal(result.hasNewer, false)
})

test('getMessages fetches newer messages with the after parameter', async () => {
  const jid = '972501234567@s.whatsapp.net'
  const payloads = {
    m2: JSON.stringify({ id: 'm2', jid, text: 'newer', sender: 'A', fromMe: false, timestamp: 200, type: 'conversation' })
  }
  let usedMethod = ''
  const fakeBot: any = {
    messageIndexKey: (j: string) => `idx:${j}`,
    contactCache: { canonicalJid: (value: string) => value },
    messageStore: { loadMessagePayloads: async (_j: string, ids: string[]) => ids.map(id => payloads[id] || null) },
    publicMessage: (message: any) => message,
    redis: {
      zrangebyscore: async () => { usedMethod = 'zrangebyscore'; return ['m2'] },
      zrevrangebyscore: async () => { usedMethod = 'zrevrangebyscore'; return [] },
      zrange: async () => { usedMethod = 'zrange'; return [] }
    }
  }

  const messages = await Bot.prototype.getMessages.call(fakeBot, jid, 100, undefined, 150)

  assert.equal(usedMethod, 'zrangebyscore')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, 'm2')
})
