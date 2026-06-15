import assert from 'node:assert/strict'
import { test } from 'node:test'

const baseUrl = requiredEnv('E2E_BASE_URL').replace(/\/+$/, '')
const password = requiredEnv('E2E_UI_PASSWORD')
const senderBot = process.env.E2E_SENDER_BOT || 'bot1'
const receiverBot = process.env.E2E_RECEIVER_BOT || 'bot2'
const groupJid = requiredEnv('E2E_GROUP_JID')
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 120000)
const cleanup = process.env.E2E_CLEANUP === 'true'
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let sessionCookie = ''

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for live E2E tests`)
  return value
}

async function api(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(sessionCookie ? { Cookie: sessionCookie } : {})
    }
  })
  const body = await response.json().catch(() => ({})) as Record<string, any>
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} returned ${response.status}: ${body.error || JSON.stringify(body)}`)
  if (path === '/api/login') sessionCookie = response.headers.get('set-cookie')?.split(';')[0] || ''
  return body
}

function post(path: string, data: Record<string, any>) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
}

async function messages(bot: string) {
  const data = await api(`/api/messages?bot=${encodeURIComponent(bot)}&jid=${encodeURIComponent(groupJid)}&limit=500`)
  return Array.isArray(data.messages) ? data.messages : []
}

async function waitForMessage(bot: string, predicate: (message: any) => boolean, description: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await messages(bot)).find(predicate)
    if (found) return found
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for ${description} on ${bot}`)
}

test('live WhatsApp group flow between two phones', { timeout: timeoutMs * 5 }, async t => {
  await t.test('login and verify both bot sessions are connected', async () => {
    const login = await post('/api/login', { password })
    assert.equal(login.token, undefined)
    assert.match(sessionCookie, /^wa_ui_session=/)

    const session = await api('/api/session')
    const bots = new Map((session.bots || []).map((bot: any) => [bot.id, bot]))
    assert.equal(bots.get(senderBot)?.connection, 'open', `${senderBot} must be connected`)
    assert.equal(bots.get(receiverBot)?.connection, 'open', `${receiverBot} must be connected`)
  })

  const firstText = `[E2E ${runId}] phone 1 to group`
  const replyText = `[E2E ${runId}] phone 2 reply`
  let firstMessage: any
  let replyMessage: any

  try {
    await t.test('phone 1 sends and phone 2 receives a group message', async () => {
      const sent = await post('/api/send', { bot: senderBot, jid: groupJid, text: firstText })
      assert.equal(sent.message?.text, firstText)
      firstMessage = await waitForMessage(receiverBot, message => message.text === firstText, firstText)
      assert.equal(firstMessage.fromMe, false)
    })

    await t.test('phone 2 replies and phone 1 receives the quoted reply', async () => {
      const sent = await post('/api/send', {
        bot: receiverBot,
        jid: groupJid,
        text: replyText,
        quotedId: firstMessage.id
      })
      assert.equal(sent.message?.text, replyText)
      replyMessage = await waitForMessage(senderBot, message => message.text === replyText, replyText)
      assert.equal(replyMessage.fromMe, false)
      assert.equal(replyMessage.quoted?.id, firstMessage.id)
    })

    await t.test('phone 1 reacts and phone 2 stores the reaction', async () => {
      await post('/api/react-message', { bot: senderBot, jid: groupJid, id: replyMessage.id, emoji: '👍' })
      const reacted = await waitForMessage(
        receiverBot,
        message => message.id === replyMessage.id && message.reactions?.some((reaction: any) => reaction.text === '👍'),
        'reaction'
      )
      assert.ok(reacted.reactions.some((reaction: any) => reaction.text === '👍'))
    })

    await t.test('phone 2 can mark the group read', async () => {
      const result = await post('/api/mark-read', { bot: receiverBot, jid: groupJid })
      assert.equal(result.ok, true)
      assert.equal(typeof result.marked, 'number')
    })
  } finally {
    if (cleanup) {
      if (replyMessage?.id) await post('/api/delete-message', { bot: receiverBot, jid: groupJid, id: replyMessage.id }).catch(() => {})
      if (firstMessage?.id) await post('/api/delete-message', { bot: senderBot, jid: groupJid, id: firstMessage.id }).catch(() => {})
    }
  }
})
