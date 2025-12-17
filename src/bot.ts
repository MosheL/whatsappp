import {makeWASocket, fetchLatestBaileysVersion, downloadMediaMessage,isJidGroup} from '@whiskeysockets/baileys'
import { useRedisAuthStateWithHSet } from 'baileys-redis-auth'

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'
import qrcode from 'qrcode-terminal'

const redisOptions = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASS || undefined,
  db:6
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function transcribeBuffer(buffer: Buffer): Promise<string> {
  try {
    const res = await axios.post(
      'http://10.0.7.10:8000/transcribe',
      { type: 'blob', data: buffer.toString('base64'), model: 'ivrit-ai/whisper-large-v3-turbo-ct2' },
      { headers: { 'Content-Type': 'application/json' } }
    )
    return res.data.text || ''
  } catch (err: any) {
    console.error('❌ שגיאה בתמלול:', err.message)
    return ''
  }
}

// self-heal: ניקוי sender-key רק לקבוצה הבעייתית (ללא שמירת הודעות)
function purgeGroupSenderKeys(authDir: string, groupJid: string) {
  try {
    const files = fs.readdirSync(authDir)
    let removed = 0
    for (const f of files) {
      if (f.startsWith('sender-key-') && f.includes(groupJid)) {
        fs.unlinkSync(path.join(authDir, f))
        removed++
      }
    }
    if (removed) console.log('🧹 נוקו sender-key x' + removed, 'עבור', groupJid)
  } catch (e: any) {
    console.log('⚠️ ניקוי sender-key נכשל:', e?.message)
  }
}

const transcriptionCache = new Map<string, string>()
const CACHE_LIMIT = 100

export async function createBot(authFolder: string, label: string) {
  const { state, saveCreds, redis: authRedisInstance } =
  await useRedisAuthStateWithHSet(redisOptions, authFolder, console.log)
  const { version } = await fetchLatestBaileysVersion()

  // זוכר רק מתי ניקינו לכל קבוצה (in-memory)
  const healedGroups = new Map<string, number>() // groupJid -> last heal ts

  const wrapper = {
    sock: undefined as ReturnType<typeof makeWASocket> | undefined,
    id: '',
    async sendText(jid: string, text: string) {
      if (!wrapper.sock) throw new Error('Socket not connected')
      return await wrapper.sock.sendMessage(jid, { text })
    }
  }

  async function startSock() {
    const sock = makeWASocket({
      version,
      auth: state,
      shouldIgnoreJid: jid => jid === 'status@broadcast',
      //shouldIgnoreJidMissingInDeviceList: true,
      syncFullHistory: true // עוזר לסנכרון מפתחות בלי לשמור הודעות
      // בלי msgRetryCounterCache, בלי getMessage, בלי store
    })

    wrapper.sock = sock
    wrapper.id = sock.user?.id || ''

    sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        console.log(`${label} 📱 סרוק את הקוד:`)
        qrcode.generate(qr, { small: true })
      }
      if (connection === 'open') console.log(`${label} ✅ התחברת בהצלחה ל־WhatsApp`)
      if (connection === 'close') {
        console.log(`${label} ❌ החיבור נסגר:`, lastDisconnect?.error)
        setTimeout(startSock, 5000)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    async function handleAudioTranscription(msg: any) {
      if (!msg.message) return
      const type = Object.keys(msg.message)[0]
      if (type !== 'audioMessage') return

      const remoteJid = msg.key.remoteJid!
      const fromGroup = isJidGroup(remoteJid)
      const id = msg.key.id
      console.log(`${label} 📥 קולית נכנסה! ${id}`)

      if (transcriptionCache.has(id)) {
        console.log(`${label} 📝 תמלול כבר קיים במטמון.`)
        return
      }

      const tryOnce = async () => {
        transcriptionCache.set(id,"wait");
        // שולחים הודעת מצב שלנו (נשתמש במפתח שלה לעריכה)
        const sentMsg = await sock.sendMessage(remoteJid, { text: '📝 מתמלל...' }, { quoted: msg })

        // הורדת המדיה; במידת הצורך Baileys יבקש reupload
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: sock.logger!, reuploadRequest: sock.updateMediaMessage }
        ) as Buffer

        const transcript = await transcribeBuffer(buffer)
        transcriptionCache.set(id, transcript)
        if (transcriptionCache.size > CACHE_LIMIT) {
          const oldestKey = transcriptionCache.keys().next().value
          transcriptionCache.delete(oldestKey)
        }

        await sock.sendMessage(remoteJid, {
          edit: sentMsg.key, // עורכים רק את ההודעה שלנו
          text: transcript ? `📝 תמלול:\n${transcript}` : '❌ לא הצלחתי לתמלל.'
        })
      }

      try {
        await tryOnce()
      } catch (e: any) {
  const msgTxt = String(e?.message || e)
  const stackTxt = String(e?.stack || '')

  // נזהה שגיאות קבוצתיות רחבות יותר, כולל typeerror ב-sender-key-state/group_cipher
  const isGroup = fromGroup
  const looksLikeGroupDecrypt =
    /InvalidMessageException|Bad MAC|No matching sessions/i.test(msgTxt) ||
    /sender-key-state|group_cipher|GroupCipher|reading 'push'/i.test(msgTxt + ' ' + stackTxt)

  if (isGroup && looksLikeGroupDecrypt) {
    const last = healedGroups.get(remoteJid) || 0
    const now = Date.now()
    if (now - last > 10 * 60 * 1000) { // לא יותר מפעם ב-10 דק׳ לקבוצה
      purgeGroupSenderKeys(authFolder, remoteJid)
      healedGroups.set(remoteJid, now)
    }
    // נסיון נוסף אחרי self-heal
    try {
      await tryOnce()
      return
    } catch (e2) {
      console.error(`${label} ❌ אחרי self-heal עדיין נכשל:`, String((e2 as any)?.message || e2))
    }
  } else {
    console.error(`${label} ❌ שגיאה:`, msgTxt)
  }
}

    }

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        try { await handleAudioTranscription(m) } catch {}
      }
    })
  }

  await startSock()
  return wrapper
}
