import { Bot, createBot } from './bot.ts'
import type { BotStatus } from './types.ts'
import Busboy from 'busboy'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'
import serveStatic from 'serve-static'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')
const port = Number(process.env.PORT || 3000)
const uiPassword = process.env.WHATSAPP_UI_PASSWORD || process.env.UI_PASSWORD || process.env.WEB_PASSWORD || 'admin'
const sessionSecret = process.env.WHATSAPP_UI_SESSION_SECRET || crypto.createHmac('sha256', 'wa-ui-salt').update(uiPassword).digest('base64url')
const tokenTtlMs = Number(process.env.WHATSAPP_UI_TOKEN_TTL_MS || 30 * 24 * 60 * 60 * 1000)
const sessionCookieName = 'wa_ui_session'
const externalApiKey = process.env.WHATSAPP_EXTERNAL_API_KEY || ''
const maxFailedLogins = Number(process.env.MAX_FAILED_LOGINS || 10)
const loginBlockDurationMs = Number(process.env.LOGIN_BLOCK_DURATION_MS || 30 * 60 * 1000)
const bots = new Map<string, Bot>()
const apiTestMode = process.env.API_TEST_MODE === 'true'

// IP tracking for failed login attempts
const loginAttempts = new Map<string, { count: number, blockedUntil: number }>()

async function readBotJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ data: Record<string, any>; bot: Bot } | undefined> {
  let data: Record<string, any>
  try {
    data = await readBody(req)
  } catch {
    sendJson(res, 400, { error: 'בקשה לא תקינה' })
    return
  }
  const bot = bots.get(data.bot)
  if (!bot) {
    sendJson(res, 404, { error: 'לקוח לא נמצא' })
    return
  }
  return { data, bot }
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]
    return first.trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

function checkIpBlocked(ip: string): boolean {
  const entry = loginAttempts.get(ip)
  if (!entry) return false
  if (entry.blockedUntil && Date.now() < entry.blockedUntil) return true
  if (entry.blockedUntil && Date.now() >= entry.blockedUntil) {
    loginAttempts.delete(ip)
    return false
  }
  return false
}

function recordFailedLogin(ip: string) {
  let entry = loginAttempts.get(ip)
  if (!entry) {
    entry = { count: 0, blockedUntil: 0 }
    loginAttempts.set(ip, entry)
  }
  entry.count += 1
  if (entry.count >= maxFailedLogins) {
    entry.blockedUntil = Date.now() + loginBlockDurationMs
  }
}

function resetLoginAttempts(ip: string) {
  loginAttempts.delete(ip)
}

if (!apiTestMode) {
  await Promise.all([
    createBot('auth', 'לקוח 1', 'bot1').then(bot => bots.set('bot1', bot)),
    createBot('auth2', 'לקוח 2', 'bot2').then(bot => bots.set('bot2', bot))
  ])
}

function sniffImageMime(buffer: Buffer): string {
  if (!buffer || buffer.length < 12) return 'application/octet-stream'
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  return 'application/octet-stream'
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(data))
}

function readBody(req: http.IncomingMessage) {
  return new Promise<any>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function readMultipart(req: http.IncomingMessage) {
  return new Promise<{
    fields: Record<string, string>
    file?: { buffer: Buffer, fileName: string, mimeType: string }
  }>((resolve, reject) => {
    const fields: Record<string, string> = {}
    let file: { chunks: Buffer[], fileName: string, mimeType: string } | undefined
    const busboy = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: 50 * 1024 * 1024 } })

    busboy.on('field', (name, value) => {
      fields[name] = value
    })
    busboy.on('file', (_name, stream, info) => {
      file = { chunks: [], fileName: normalizeUploadedFileName(info.filename || 'file'), mimeType: info.mimeType || 'application/octet-stream' }
      stream.on('data', chunk => file?.chunks.push(chunk))
    })
    busboy.on('error', reject)
    busboy.on('finish', () => {
      resolve({
        fields,
        file: file ? { buffer: Buffer.concat(file.chunks), fileName: file.fileName, mimeType: file.mimeType } : undefined
      })
    })
    req.pipe(busboy)
  })
}

function normalizeUploadedFileName(fileName: string) {
  const clean = fileName.replace(/[/\\]/g, '').trim() || 'file'
  if (!/[ÃÂ×�]/.test(clean)) return clean
  try {
    const repaired = Buffer.from(clean, 'latin1').toString('utf8')
    if (/[\u0590-\u05ff]/.test(repaired)) return repaired.replace(/[/\\]/g, '').trim() || clean
  } catch {}
  return clean
}

function contentDisposition(fileName: string) {
  const clean = (fileName || 'file').replace(/[\r\n"]/g, '').replace(/[/\\]/g, '').trim() || 'file'
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_')
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(clean)}`
}

function getCookies(req: http.IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

function getToken(req: http.IncomingMessage) {
  const header = req.headers.authorization || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  return bearer || getCookies(req)[sessionCookieName] || ''
}

function sessionCookie(req: http.IncomingMessage, token: string, maxAgeSeconds: number) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
  const secure = forwardedProto === 'https' || Boolean((req.socket as any).encrypted)
  return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

function isExternalAuthed(req: http.IncomingMessage) {
  if (!externalApiKey) return false
  const supplied = String(req.headers['x-api-key'] || '')
  const expected = Buffer.from(externalApiKey)
  const actual = Buffer.from(supplied)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function base64url(data: string | Buffer) {
  return Buffer.from(data).toString('base64url')
}

function sign(data: string) {
  return crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url')
}

function createSessionToken() {
  const payload = base64url(JSON.stringify({ iat: Date.now(), exp: Date.now() + tokenTtlMs }))
  return `${payload}.${sign(payload)}`
}

function verifySessionToken(token: string) {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return false
  const expected = sign(payload)
  if (signature.length !== expected.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Number(data.exp || 0) > Date.now()
  } catch {
    return false
  }
}

function isAuthed(req: http.IncomingMessage) {
  return verifySessionToken(getToken(req))
}

function botPayload() {
  return [...bots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, bot]) => {
    const status = bot.status()
    return { ...status, id, accountId: status.id }
  })
}

function getRequestedBot(id?: string | null) {
  if (id && bots.has(id)) return bots.get(id)
  return [...bots.entries()].sort(([a], [b]) => a.localeCompare(b))[0]?.[1]
}

function serveStaticMiddleware(req: http.IncomingMessage, res: http.ServerResponse) {
  serveStatic(distDir, {
    dotfiles: 'deny',
    index: ['index.html'],
    setHeaders: (res, path, stat) => {
      res.setHeader('Cache-Control', 'no-store')
    }
  })(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('UI not built. Run npm run build.')
  })
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)



  if (req.method === 'POST' && url.pathname === '/api/login') {
    try {
      const ip = getClientIp(req)
      
      if (checkIpBlocked(ip)) {
        sendJson(res, 429, { error: 'יותר מדי ניסיונות כניסה. נסה שוב מאוחר יותר.' })
        return
      }
      
      const data = await readBody(req)
      if (data.password !== uiPassword) {
        recordFailedLogin(ip)
        sendJson(res, 401, { error: 'סיסמה שגויה' })
        return
      }
      resetLoginAttempts(ip)
      const token = createSessionToken()
      res.setHeader('Set-Cookie', sessionCookie(req, token, Math.max(1, Math.floor(tokenTtlMs / 1000))))
      sendJson(res, 200, { bots: botPayload() })
    } catch {
      sendJson(res, 400, { error: 'בקשה לא תקינה' })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    if (!isExternalAuthed(req)) {
      sendJson(res, 401, { error: 'External API key required' })
      return
    }
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      await parsed.bot.sendText(parsed.data.jid, parsed.data.text)
      res.end('OK')
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(err.message)
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0))
    sendJson(res, 200, { ok: true })
    return
  }

  if (url.pathname.startsWith('/api/') && !isAuthed(req)) {
    sendJson(res, 401, { error: 'נדרש להתחבר' })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/avatar') {
    try {
      const botId = url.searchParams.get('bot') || ''
      let jid = url.searchParams.get('jid') || ''
      const bot = bots.get(botId)
      if (!bot || !jid) {
        sendJson(res, 404, { error: 'לא נמצא' })
        return
      }
      jid = bot.contactCache.canonicalJid(jid)
      const cacheKey = `ui:${bot.authKey}:avatar:${jid}`
      const cached = await bot.redis.getBuffer(cacheKey)
      if (cached) {
        res.writeHead(200, {
          'Content-Type': sniffImageMime(cached),
          'Cache-Control': 'private, max-age=86400'
        })
        res.end(cached)
      } else {
        await bot.loadAvatar(jid)
        const refreshed = await bot.redis.getBuffer(cacheKey)
        if (refreshed) {
          res.writeHead(200, {
            'Content-Type': sniffImageMime(refreshed),
            'Cache-Control': 'private, max-age=86400'
          })
          res.end(refreshed)
        } else {
          sendJson(res, 404, { error: 'תמונה לא זמינה' })
        }
      }
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    sendJson(res, 200, { bots: botPayload() })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/chats') {
    const bot = getRequestedBot(url.searchParams.get('bot'))
    if (!bot) {
      sendJson(res, 404, { error: 'לקוח לא נמצא' })
      return
    }
    const chats = bot.listChats().filter(chat => chat.timestamp || chat.lastMessage)
    sendJson(res, 200, { chats })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/contacts') {
    const bot = getRequestedBot(url.searchParams.get('bot'))
    if (!bot) {
      sendJson(res, 404, { error: 'לקוח לא נמצא' })
      return
    }
    const contacts = bot.listContacts()
    sendJson(res, 200, { contacts })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const bot = bots.get(url.searchParams.get('bot') || '')
    const jid = url.searchParams.get('jid') || ''
    const before = Number(url.searchParams.get('before') || 0) || undefined
    const after = Number(url.searchParams.get('after') || 0) || undefined
    const limit = Number(url.searchParams.get('limit') || 200)
    if (!bot) {
      sendJson(res, 404, { error: 'לקוח לא נמצא' })
      return
    }
    sendJson(res, 200, { messages: await bot.getMessages(jid, limit, before, after) })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/messages-around') {
    const jid = url.searchParams.get('jid') || ''
    const id = url.searchParams.get('id') || ''
    if (!jid || !id) {
      sendJson(res, 400, { error: 'חסר נמען או הודעה' })
      return
    }
    const bot = bots.get(url.searchParams.get('bot') || '')
    const limit = Number(url.searchParams.get('limit') || 40)
    if (!bot) {
      sendJson(res, 404, { error: 'לקוח לא נמצא' })
      return
    }
    try {
      sendJson(res, 200, await bot.getMessagesAround(jid, id, limit))
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const bot = getRequestedBot(url.searchParams.get('bot'))
    if (!bot) {
      sendJson(res, 404, { error: 'לקוח לא נמצא' })
      return
    }
    const q = url.searchParams.get('q') || ''
    const limit = Number(url.searchParams.get('limit') || 50)
    const chat = url.searchParams.get('chat') || undefined
    try {
      sendJson(res, 200, await bot.searchMessages(q, { chatJid: chat, limit }))
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/group-participants') {
    const bot = bots.get(url.searchParams.get('bot') || '')
    const jid = url.searchParams.get('jid') || ''
    if (!bot) {
      sendJson(res, 404, { error: 'לקוח לא נמצא' })
      return
    }
    try {
      const [participants, info] = await Promise.all([bot.groupParticipants(jid), bot.groupInfo(jid)])
      sendJson(res, 200, { participants, info })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/group-add') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    const { data, bot } = parsed
    try {
      await bot.groupAddParticipant(data.jid, data.phone)
      sendJson(res, 200, { ok: true })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/group-leave') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    const { data, bot } = parsed
    try {
      await bot.groupLeave(data.jid)
      sendJson(res, 200, { ok: true })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/group-update') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    const { data, bot } = parsed
    try {
      const subject = typeof data.subject === 'string' ? data.subject : undefined
      const description = typeof data.description === 'string' ? data.description : undefined
      await bot.groupUpdate(data.jid, subject, description)
      sendJson(res, 200, { ok: true })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/media') {
    try {
      const bot = bots.get(url.searchParams.get('bot') || '')
      const jid = url.searchParams.get('jid') || ''
      const id = url.searchParams.get('id') || ''
      if (!bot) {
        sendJson(res, 404, { error: 'לקוח לא נמצא' })
        return
      }
      if (!jid || !id) {
        sendJson(res, 400, { error: 'חסר מזהה מדיה' })
        return
      }
      const media = await bot.getMedia(jid, id)
      res.writeHead(200, {
        'Content-Type': media.mimetype,
        'Content-Disposition': contentDisposition(media.fileName || id),
        'Cache-Control': 'private, max-age=86400'
      })
      res.end(media.buffer)
    } catch (err: any) {
      sendJson(res, 404, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/sync-messages') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid) {
        sendJson(res, 400, { error: 'חסר נמען' })
        return
      }
      const result = await parsed.bot.syncOlderMessages(parsed.data.jid, Number(parsed.data.count || 50))
      sendJson(res, 200, { ok: true, ...result })
    } catch (err: any) {
      sendJson(res, Number(err.statusCode || 500), { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/mark-read') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid) {
        sendJson(res, 400, { error: 'חסר נמען' })
        return
      }
      const result = await parsed.bot.markRead(parsed.data.jid)
      sendJson(res, 200, { ok: true, ...result })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/mark-all-read') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      const result = await parsed.bot.markAllRead()
      sendJson(res, 200, { ok: true, ...result })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/local-read') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid) {
        sendJson(res, 400, { error: 'חסר נמען' })
        return
      }
      const result = await parsed.bot.markLocalRead(parsed.data.jid)
      sendJson(res, 200, { ok: true, ...result })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/send') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid || !parsed.data.text) {
        sendJson(res, 400, { error: 'חסר נמען או טקסט' })
        return
      }
      const mentions = Array.isArray(parsed.data.mentions) ? parsed.data.mentions.filter((value: any) => typeof value === 'string') : []
      const message = await parsed.bot.sendText(parsed.data.jid, parsed.data.text, parsed.data.quotedId || '', parsed.data.quotedJid || '', mentions)
      sendJson(res, 200, { ok: true, message })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/link-preview') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      const preview = await parsed.bot.previewText(String(parsed.data.text || ''))
      sendJson(res, 200, { ok: true, preview: preview || null })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/delete-message') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid || !parsed.data.id) {
        sendJson(res, 400, { error: 'חסר נמען או הודעה' })
        return
      }
      const result = await parsed.bot.deleteMessage(parsed.data.jid, parsed.data.id)
      sendJson(res, 200, { ok: true, ...result })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/react-message') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid || !parsed.data.id || typeof parsed.data.emoji !== 'string') {
        sendJson(res, 400, { error: 'חסר נמען, הודעה או אימוג׳י' })
        return
      }
      const result = await parsed.bot.reactMessage(parsed.data.jid, parsed.data.id, parsed.data.emoji)
      sendJson(res, 200, { ok: true, ...result })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/forward-message') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.sourceJid || !parsed.data.sourceId || !parsed.data.targetJid) {
        sendJson(res, 400, { error: 'חסר מקור, הודעה או יעד' })
        return
      }
      const result = await parsed.bot.forwardMessage(parsed.data.sourceJid, parsed.data.sourceId, parsed.data.targetJid)
      sendJson(res, 200, { ok: true, message: result })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/send-contact') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid || !parsed.data.displayName || !parsed.data.vcard) {
        sendJson(res, 400, { error: 'חסר נמען, שם או vCard' })
        return
      }
      const message = await parsed.bot.sendContact(parsed.data.jid, parsed.data.displayName, parsed.data.vcard)
      sendJson(res, 200, { ok: true, message })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  // -------- Chat archive/mute --------

  if (req.method === 'POST' && url.pathname === '/api/chat-archive') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid || typeof parsed.data.archive !== 'boolean') {
        sendJson(res, 400, { error: 'חסר jid או ערך archive' })
        return
      }
      const result = await parsed.bot.archiveChat(parsed.data.jid, parsed.data.archive)
      // Emit chat update event to refresh UI
      const chat = parsed.bot.chats.get(parsed.bot.contactCache.canonicalJid(parsed.data.jid))
      if (chat) {
        parsed.bot.events.emit('event', { type: 'chat', bot: parsed.authKey, chat })
      }
      sendJson(res, 200, result)
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/chat-mute') {
    const parsed = await readBotJson(req, res)
    if (!parsed) return
    try {
      if (!parsed.data.jid || typeof parsed.data.muted !== 'boolean') {
        sendJson(res, 400, { error: 'חסר jid או ערך muted' })
        return
      }
      const result = await parsed.bot.muteChat(parsed.data.jid, parsed.data.muted)
      // Emit chat update event to refresh UI
      const chat = parsed.bot.chats.get(parsed.bot.contactCache.canonicalJid(parsed.data.jid))
      if (chat) {
        parsed.bot.events.emit('event', { type: 'chat', bot: parsed.authKey, chat })
      }
      sendJson(res, 200, result)
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/send-file') {
    try {
      const data = await readMultipart(req)
      const bot = bots.get(data.fields.bot)
      if (!bot) {
        sendJson(res, 404, { error: 'לקוח לא נמצא' })
        return
      }
      if (!data.fields.jid || !data.file) {
        sendJson(res, 400, { error: 'חסר נמען או קובץ' })
        return
      }
      const message = await bot.sendFile(
        data.fields.jid,
        data.file.buffer,
        data.file.fileName,
        data.file.mimeType,
        data.fields.caption || '',
        data.fields.forwarded === 'true'
      )
      sendJson(res, 200, { ok: true, message })
    } catch (err: any) {
      sendJson(res, 500, { error: err.message })
    }
    return
  }

  serveStaticMiddleware(req, res)
}

export const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('HTTP request failed', err)
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' })
    else res.destroy()
  })
})

const wss = new WebSocketServer({ noServer: true })

function wsSend(ws: any, data: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data))
}

wss.on('connection', ws => {
  wsSend(ws, { type: 'init', bots: botPayload() })
})

for (const [id, bot] of bots) {
  bot.events.on('event', event => {
    for (const client of wss.clients) {
      wsSend(client, { ...event, bot: id })
    }
  })
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  if (url.pathname !== '/ws' || !isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})

if (!apiTestMode) {
  server.listen(port, () => {
    console.log(`HTTP and WebSocket UI on http://localhost:${port}`)
    if (uiPassword === 'admin') console.log('Default UI password is admin. Set WHATSAPP_UI_PASSWORD in production.')
  })
}
